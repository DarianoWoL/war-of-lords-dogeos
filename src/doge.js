// Pomocnicze funkcje DOGE: walidacja adresu (Base58Check) i hasha transakcji, zaokraglanie kwot.
const crypto = require('crypto');

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
// Wersje adresow sieci glownej Dogecoin: 0x1E = P2PKH (zaczyna sie od "D"), 0x16 = P2SH ("9"/"A").
// Gracz moze podac tylko adres "D..." - tak jak w opisie formularza.
const P2PKH_VERSION = 0x1e;

function base58Decode(text) {
  let num = 0n;
  for (const ch of text) {
    const value = BASE58.indexOf(ch);
    if (value < 0) return null;
    num = num * 58n + BigInt(value);
  }
  let hex = num.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const leadingZeros = text.match(/^1*/)[0].length;
  return Buffer.concat([Buffer.alloc(leadingZeros), Buffer.from(num === 0n ? '' : hex, 'hex')]);
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest();
}

// Adres D...: 34 znaki base58, wersja 0x1E i poprawna suma kontrolna (4 bajty podwojnego SHA-256).
function isValidDogeAddress(address) {
  if (typeof address !== 'string' || !/^D[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) return false;
  const bytes = base58Decode(address);
  if (!bytes || bytes.length !== 25 || bytes[0] !== P2PKH_VERSION) return false;
  const payload = bytes.subarray(0, 21);
  const checksum = sha256(sha256(payload)).subarray(0, 4);
  return checksum.equals(bytes.subarray(21));
}

function isValidTxHash(hash) {
  return typeof hash === 'string' && /^[0-9a-fA-F]{64}$/.test(hash.trim());
}

// Kwoty DOGE trzymamy z dokladnoscia do 2 miejsc po przecinku (unikamy bledow typu 0.1 + 0.2).
function roundDoge(value) {
  return Math.round(Number(value) * 100) / 100;
}

module.exports = { isValidDogeAddress, isValidTxHash, roundDoge };
