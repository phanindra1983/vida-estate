// Where the website finds Vida OS (staff login and enquiry form).
// On this Mac (localhost) it uses the local Vida OS; anywhere else the public address.
window.VIDA_OS_URL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
  ? 'http://localhost:3100'
  : 'https://vida-os-eosin.vercel.app';
