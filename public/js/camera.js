/* In-app camera. The only way to attach a photo is to take it here, so
   gallery pictures, screenshots and re-uploads are kept out. */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  let stream = null;
  let facing = 'environment';
  let resolver = null;

  async function start() {
    stop();
    const constraints = { audio: false, video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } } };
    stream = await navigator.mediaDevices.getUserMedia(constraints);
    const v = $('#cam-video');
    v.srcObject = stream;
    await v.play();
  }
  function stop() {
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  }
  function close(result) {
    stop();
    $('#camera').hidden = true;
    document.body.classList.remove('cam-open');
    if (resolver) { const r = resolver; resolver = null; r(result); }
  }

  async function open() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('camera_unsupported');
    if (!window.isSecureContext) throw new Error('camera_insecure');
    $('#camera').hidden = false;
    document.body.classList.add('cam-open');
    $('#cam-error').hidden = true;
    try {
      await start();
    } catch (e) {
      close(null);
      throw new Error(e?.name === 'NotAllowedError' ? 'camera_denied' : 'camera_failed');
    }
    return new Promise((resolve) => { resolver = resolve; });
  }

  function shoot() {
    const v = $('#cam-video');
    if (!v.videoWidth) return;
    const c = document.createElement('canvas');
    const maxEdge = 2400;
    const sc = Math.min(1, maxEdge / Math.max(v.videoWidth, v.videoHeight));
    c.width = Math.round(v.videoWidth * sc); c.height = Math.round(v.videoHeight * sc);
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    c.toBlob((blob) => {
      if (!blob) return;
      const file = new File([blob], `plate-${Date.now()}.jpg`, { type: 'image/jpeg' });
      close(file);
    }, 'image/jpeg', 0.92);
  }

  async function flip() {
    facing = facing === 'environment' ? 'user' : 'environment';
    try { await start(); } catch { facing = facing === 'environment' ? 'user' : 'environment'; }
  }

  document.addEventListener('DOMContentLoaded', () => {
    $('#cam-shoot').addEventListener('click', shoot);
    $('#cam-flip').addEventListener('click', flip);
    $('#cam-cancel').addEventListener('click', () => close(null));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#camera').hidden) close(null); });
  });

  window.AppCamera = { open };
})();
