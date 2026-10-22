// Minimal HotPay REST API client — "API zaawansowane z walidacją parametrów" variant (server-to-
// server transaction registration that returns JSON with a redirect URL), per HotPay's own official
// documentation at https://dokumentacja.hotpay.pl/. Field names and signature formulas copied
// verbatim from that spec (both the "Zmienne" table and the NODEJS code sample).
const crypto = require('crypto');

const SEKRET = process.env.HOTPAY_SEKRET || '';
// "Hasło notyfikacji" — a secret set by the merchant in the HotPay panel (Ustawienia serwisu),
// separate from SEKRET. Used only inside the HASH formula below, never sent as its own field.
const NOTIFICATION_PASSWORD = process.env.HOTPAY_NOTIFICATION_PASSWORD || '';
const API_URL = process.env.HOTPAY_API_URL || 'https://platnosc.hotpay.pl/';

// True only once both real secrets are present, so a half-configured deployment fails loudly
// instead of silently accepting unpayable orders.
function isConfigured() {
  return Boolean(SEKRET && NOTIFICATION_PASSWORD);
}

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

// Per spec: sha256(HASLO_Z_USTAWIEN + ";" + KWOTA + ";" + NAZWA_USLUGI + ";" + ADRES_WWW + ";" +
// ID_ZAMOWIENIA + ";" + SEKRET) — field order matters, ADRES_WWW is included even when empty.
function createPaymentSignature({ amountValue, serviceName, returnUrl, orderId }) {
  return sha256(
    NOTIFICATION_PASSWORD + ';' +
    amountValue + ';' +
    serviceName + ';' +
    (returnUrl || '') + ';' +
    orderId + ';' +
    SEKRET
  );
}

// Registers a transaction and returns { url } to redirect the player's browser to, to complete
// payment on HotPay's own page. `orderId` is our own order id and must be 1-64 characters (HotPay's
// hard limit on ID_ZAMOWIENIA) — callers pass a Mongo ObjectId's .toString(), which is always 24.
async function createPayment({ serviceName, amountZl, returnUrl, orderId, email, personalData }) {
  if (!isConfigured()) {
    throw new Error('HotPay nie jest skonfigurowany (brak HOTPAY_SEKRET / HOTPAY_NOTIFICATION_PASSWORD).');
  }
  if (!orderId || orderId.length > 64) {
    throw new Error(`HotPay ID_ZAMOWIENIA musi mieć 1-64 znaki (otrzymano ${orderId ? orderId.length : 0}).`);
  }
  const amountValue = Number(amountZl);
  const hash = createPaymentSignature({ amountValue, serviceName, returnUrl, orderId });

  const form = new FormData();
  form.append('SEKRET', SEKRET);
  form.append('KWOTA', String(amountValue));
  form.append('NAZWA_USLUGI', serviceName);
  if (returnUrl) form.append('ADRES_WWW', returnUrl);
  form.append('ID_ZAMOWIENIA', orderId);
  form.append('TYP', 'INIT');
  if (email) form.append('EMAIL', email);
  if (personalData) form.append('DANE_OSOBOWE', personalData);
  form.append('HASH', hash);

  const response = await fetch(API_URL, { method: 'POST', body: form });
  const data = await response.json().catch(() => null);
  if (!data) {
    throw new Error(`HotPay createPayment: nieprawidlowa odpowiedz (${response.status})`);
  }
  if (!data.STATUS) {
    throw new Error(`HotPay createPayment failed: ${data.WIADOMOSC || 'nieznany blad'}`);
  }
  return { url: data.URL };
}

// Verifies an incoming notification's HASH — the ONLY way to confirm a HotPay notification is
// genuine, since HotPay exposes no separate "retrieve payment status" endpoint to independently
// re-check against. Deliberately does NOT separately require `sekret` to equal our configured
// SEKRET (HotPay's own reference PHP implementation never does this either — it just plugs
// whatever SEKRET the notification carries straight into the hash) — the hash already binds
// whichever sekret value was sent, using our own secret notification password, so a forger who
// doesn't know that password still can't produce a valid hash for any sekret+payload combination.
// A prior version DID require an exact SEKRET match, which silently rejected a real, correctly-
// paid transaction's notification (see the 2026-08-27 incident) for a still-unconfirmed reason —
// removed rather than guessed at, since it added no real security on top of the hash check anyway.
function verifyNotificationSignature({ kwota, idPlatnosci, idZamowienia, status, secure, sekret, hash }) {
  if (!isConfigured()) return false;
  if (!kwota || !idPlatnosci || !idZamowienia || !status || !secure || !sekret || !hash) return false;
  const expected = sha256(
    NOTIFICATION_PASSWORD + ';' + kwota + ';' + idPlatnosci + ';' + idZamowienia + ';' + status + ';' + secure + ';' + sekret
  );
  return expected === hash;
}

// Per https://dokumentacja.hotpay.pl/ ("Odbiór notyfikacji") — notifications are only ever sent
// from these addresses; reject anything else before even checking the signature.
const NOTIFICATION_IP_WHITELIST = ['18.197.55.26', '3.126.108.86', '3.64.128.101', '18.184.99.42', '3.72.152.155', '35.159.7.168'];

// Diagnostic-only helper for the webhook's failure log — pinpoints WHERE a signature mismatch
// comes from (wrong SEKRET echoed back vs. a hash mismatch, and whether trimming whitespace off
// either configured secret would have fixed it) WITHOUT ever logging either secret's raw value.
function diagnoseNotificationMismatch({ kwota, idPlatnosci, idZamowienia, status, secure, sekret, hash }) {
  const sekretMatches = sekret === SEKRET;
  const sekretMatchesTrimmed = String(sekret || '').trim() === SEKRET.trim();
  const hashWithConfigured = sha256(NOTIFICATION_PASSWORD + ';' + kwota + ';' + idPlatnosci + ';' + idZamowienia + ';' + status + ';' + secure + ';' + sekret);
  const hashWithTrimmedPassword = sha256(NOTIFICATION_PASSWORD.trim() + ';' + kwota + ';' + idPlatnosci + ';' + idZamowienia + ';' + status + ';' + secure + ';' + sekret);
  return {
    sekretFieldMatches: sekretMatches,
    sekretMatchesIfTrimmed: sekretMatchesTrimmed && !sekretMatches,
    hashMatchesConfiguredPassword: hashWithConfigured === hash,
    hashMatchesIfPasswordTrimmed: hashWithTrimmedPassword === hash && hashWithConfigured !== hash,
    configuredSekretLength: SEKRET.length,
    receivedSekretLength: sekret ? sekret.length : 0,
    configuredPasswordLength: NOTIFICATION_PASSWORD.length
  };
}

module.exports = { isConfigured, createPayment, verifyNotificationSignature, diagnoseNotificationMismatch, NOTIFICATION_IP_WHITELIST, API_URL };
