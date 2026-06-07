'use strict';

// Thin client for the Fethiye / Babadag SHM mobile JSON API.
// Base URL was recovered from the shipped Flutter app's bundled `.env`
// (assets/flutter_assets/.env.prod -> FETHIYE_API_URL).
const API_BASE = 'https://shmapiv1.kapadokya.edu.tr/api';

/**
 * Log in and obtain a JWT bearer token.
 *
 * The endpoint is the same one the mobile app uses (`Token/SinglePost`).
 * NB: the server rejects a minimal `{userName,password}` body with HTTP 400 —
 * it expects the full payload the app sends (`email` + `rememberMe` too).
 *
 * @returns {Promise<string>} the raw JWT
 */
async function login(userName, password) {
  const res = await fetch(`${API_BASE}/Token/SinglePost`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userName,
      email: userName,
      password,
      rememberMe: true,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `Login failed (HTTP ${res.status}). ${detail}`.trim() +
        '\n  Check the username (e-mail) and password.'
    );
  }

  // The body is the bare JWT, returned as a JSON string ("eyJ...").
  const token = (await res.text()).trim().replace(/^"|"$/g, '');
  if (!token || token.length < 20) {
    throw new Error('Login succeeded but no token was returned.');
  }
  return token;
}

/**
 * Fetch the authenticated pilot's *personal* completed-flight history.
 *
 * This is the endpoint behind the app's "Completed Flights" screen. It needs an
 * explicit date range (format YYYY-MM-DD); without it the API only returns the
 * current season. A wide range returns the full history (incl. 2021).
 *
 * @returns {Promise<Array<object>>}
 */
async function fetchFlightHistory(token, startDate, endDate) {
  const url =
    `${API_BASE}/Single/GetFlightHistory` +
    `?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch flight history (HTTP ${res.status}).`);
  }

  const data = await res.json();
  if (!Array.isArray(data)) {
    throw new Error('Unexpected flight-history response (not an array).');
  }
  return data;
}

module.exports = { API_BASE, login, fetchFlightHistory };
