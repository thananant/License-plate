/* Map adapter: same small interface over Google Maps or Leaflet (OpenStreetMap). */
(function () {
  'use strict';

  // Leaflet 1.9.4 is vendored under /vendor/leaflet so no third-party CDN is contacted.
  const LEAFLET_BASE = '/vendor/leaflet';

  function loadScript(src, attrs = {}) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      Object.entries(attrs).forEach(([k, v]) => s.setAttribute(k, v));
      s.onload = resolve;
      s.onerror = () => reject(new Error('script_load_failed: ' + src));
      document.head.appendChild(s);
    });
  }
  function loadCss(href) {
    return new Promise((resolve, reject) => {
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = href;
      l.onload = resolve;
      l.onerror = () => reject(new Error('css_load_failed'));
      document.head.appendChild(l);
    });
  }

  // ---------------- Google Maps ----------------
  class GoogleMap {
    constructor(el, center, zoom) {
      this.map = new google.maps.Map(el, {
        center: { lat: center.lat, lng: center.lng },
        zoom,
        mapTypeId: 'roadmap',
        clickableIcons: false,
        fullscreenControl: false,
        streetViewControl: false,
        mapTypeControl: false,
        gestureHandling: 'greedy',
      });
      this.markers = [];
      this.draft = null;
      this.infoWindow = null;
    }
    onClick(cb) { this.map.addListener('click', (e) => cb({ lat: e.latLng.lat(), lng: e.latLng.lng() })); }
    onMoveEnd(cb) { this.map.addListener('idle', cb); }
    getCenter() { const c = this.map.getCenter(); return { lat: c.lat(), lng: c.lng() }; }
    getZoom() { return this.map.getZoom(); }
    getBounds() {
      const b = this.map.getBounds(); if (!b) return null;
      const sw = b.getSouthWest(), ne = b.getNorthEast();
      return { south: sw.lat(), west: sw.lng(), north: ne.lat(), east: ne.lng() };
    }
    panTo(p, zoom) { this.map.panTo(p); if (zoom != null) this.map.setZoom(zoom); }
    fitBounds(b) { if (b) this.map.fitBounds(b, 40); }
    toggleSatellite() {
      const sat = this.map.getMapTypeId() !== 'hybrid';
      this.map.setMapTypeId(sat ? 'hybrid' : 'roadmap');
      return sat;
    }
    setMarkers(reports, onSelect) {
      this.markers.forEach((m) => m.setMap(null));
      this.markers = reports.map((r) => {
        const m = new google.maps.Marker({
          map: this.map,
          position: { lat: r.lat, lng: r.lng },
          title: r.plate_display + ' ' + r.province,
          icon: pinIcon(r),
          optimized: true,
        });
        m.addListener('click', () => onSelect(r));
        return m;
      });
    }
    setDraft(p, onMove) {
      if (!p) { if (this.draft) this.draft.setMap(null); this.draft = null; return; }
      if (!this.draft) {
        this.draft = new google.maps.Marker({
          map: this.map, position: p, draggable: true, zIndex: 999,
          icon: { path: google.maps.SymbolPath.CIRCLE, scale: 9, fillColor: '#d42b2b', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 },
        });
        this.draft.addListener('drag', () => { const q = this.draft.getPosition(); onMove({ lat: q.lat(), lng: q.lng() }); });
        this.draft.addListener('dragend', () => { const q = this.draft.getPosition(); onMove({ lat: q.lat(), lng: q.lng() }, true); });
      } else {
        this.draft.setPosition(p);
      }
    }
    setAccuracyCircle(center, radius) {
      if (this.circle) { this.circle.setMap(null); this.circle = null; }
      if (!center || !radius) return;
      this.circle = new google.maps.Circle({
        map: this.map, center, radius, strokeColor: '#d42b2b', strokeWeight: 1, fillColor: '#d42b2b', fillOpacity: .12, clickable: false,
      });
    }
  }

  function pinIcon(r) {
    const color = r.status === 'returned' ? '#1f8f5a' : (r.vehicle_type === 'motorcycle' ? '#e0a800' : '#d42b2b');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="40" viewBox="0 0 30 40">
      <path d="M15 1C7.3 1 1 7.3 1 15c0 10 14 24 14 24s14-14 14-24C29 7.3 22.7 1 15 1z" fill="${color}" stroke="#fff" stroke-width="2"/>
      <rect x="7" y="11" width="16" height="9" rx="2" fill="#fff"/></svg>`;
    return { url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg), scaledSize: new google.maps.Size(30, 40), anchor: new google.maps.Point(15, 39) };
  }

  // ---------------- Leaflet / OSM ----------------
  class LeafletMap {
    constructor(el, center, zoom) {
      this.map = L.map(el, { zoomControl: true, attributionControl: true }).setView([center.lat, center.lng], zoom);
      // OSM's tile usage policy requires a Referer identifying the site, otherwise
      // tiles return 403 "Access blocked". Send only our origin, nothing else.
      this.street = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19, referrerPolicy: 'origin',
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" rel="noopener">OpenStreetMap</a>',
      }).addTo(this.map);
      this.sat = null;
      this.layer = L.layerGroup().addTo(this.map);
      this.draft = null;
      this.circle = null;
    }
    onClick(cb) { this.map.on('click', (e) => cb({ lat: e.latlng.lat, lng: e.latlng.lng })); }
    onMoveEnd(cb) { this.map.on('moveend', cb); }
    getCenter() { const c = this.map.getCenter(); return { lat: c.lat, lng: c.lng }; }
    getZoom() { return this.map.getZoom(); }
    getBounds() {
      const b = this.map.getBounds();
      return { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() };
    }
    panTo(p, zoom) { this.map.setView([p.lat, p.lng], zoom ?? this.map.getZoom(), { animate: true }); }
    fitBounds(b) { if (b) this.map.fitBounds([[b.south, b.west], [b.north, b.east]], { padding: [40, 40] }); }
    toggleSatellite() {
      // Leaflet has no free satellite tiles without a key; we fall back to the
      // OSM "HOT" humanitarian style which shows building outlines clearly.
      if (this.sat) { this.map.removeLayer(this.sat); this.sat = null; this.street.addTo(this.map); return false; }
      this.map.removeLayer(this.street);
      this.sat = L.tileLayer('https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', {
        maxZoom: 19, referrerPolicy: 'origin', attribution: '&copy; OpenStreetMap, HOT',
      }).addTo(this.map);
      return true;
    }
    setMarkers(reports, onSelect) {
      this.layer.clearLayers();
      reports.forEach((r) => {
        const color = r.status === 'returned' ? '#1f8f5a' : (r.vehicle_type === 'motorcycle' ? '#e0a800' : '#d42b2b');
        const icon = L.divIcon({
          className: '', iconSize: [30, 40], iconAnchor: [15, 39],
          html: `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="40" viewBox="0 0 30 40"><path d="M15 1C7.3 1 1 7.3 1 15c0 10 14 24 14 24s14-14 14-24C29 7.3 22.7 1 15 1z" fill="${color}" stroke="#fff" stroke-width="2"/><rect x="7" y="11" width="16" height="9" rx="2" fill="#fff"/></svg>`,
        });
        L.marker([r.lat, r.lng], { icon, title: r.plate_display + ' ' + r.province }).on('click', () => onSelect(r)).addTo(this.layer);
      });
    }
    setDraft(p, onMove) {
      if (!p) { if (this.draft) this.map.removeLayer(this.draft); this.draft = null; return; }
      if (!this.draft) {
        const icon = L.divIcon({ className: '', iconSize: [22, 22], iconAnchor: [11, 11], html: '<div style="width:22px;height:22px;border-radius:50%;background:#d42b2b;border:3px solid #fff;box-shadow:0 1px 6px rgba(0,0,0,.4)"></div>' });
        this.draft = L.marker([p.lat, p.lng], { icon, draggable: true, zIndexOffset: 1000, autoPan: true }).addTo(this.map);
        this.draft.on('drag', () => { const q = this.draft.getLatLng(); onMove({ lat: q.lat, lng: q.lng }); });
        this.draft.on('dragend', () => { const q = this.draft.getLatLng(); onMove({ lat: q.lat, lng: q.lng }, true); });
      } else {
        this.draft.setLatLng([p.lat, p.lng]);
      }
    }
    setAccuracyCircle(center, radius) {
      if (this.circle) { this.map.removeLayer(this.circle); this.circle = null; }
      if (!center || !radius) return;
      this.circle = L.circle([center.lat, center.lng], { radius, color: '#d42b2b', weight: 1, fillOpacity: .12, interactive: false }).addTo(this.map);
    }
  }

  // ---------------- loader ----------------
  async function createMap(el, cfg) {
    const { center } = cfg;
    if (cfg.mapProvider === 'google' && cfg.googleMapsApiKey) {
      try {
        await new Promise((resolve, reject) => {
          window.__gmapsReady = resolve;
          const key = encodeURIComponent(cfg.googleMapsApiKey);
          loadScript(`https://maps.googleapis.com/maps/api/js?key=${key}&v=weekly&language=th&region=TH&callback=__gmapsReady&loading=async`).catch(reject);
          setTimeout(() => reject(new Error('gmaps_timeout')), 15000);
        });
        return new GoogleMap(el, center, center.zoom);
      } catch (e) {
        console.warn('Google Maps failed, falling back to OpenStreetMap', e);
      }
    }
    await loadCss(`${LEAFLET_BASE}/leaflet.css`);
    await loadScript(`${LEAFLET_BASE}/leaflet.js`);
    return new LeafletMap(el, center, center.zoom);
  }

  window.PlateMap = { createMap };
})();
