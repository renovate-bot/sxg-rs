/**
 * Copyright 2021 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

function acceptsSxg(request) {
  const accept = request.headers.get('accept') || '';
  return accept.includes('application/signed-exchange');
}

// https://wicg.github.io/webpackage/draft-yasskin-httpbis-origin-signed-exchanges-impl.html#name-uncached-header-fields
const UNCACHED_HEADERS = [
  'connection',
  'keep-alive',
  'proxy-connection',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

// https://wicg.github.io/webpackage/draft-yasskin-http-origin-signed-responses.html#stateful-headers
const STATEFUL_HEADERS = [
  'authentication-control',
  'authentication-info',
  'clear-site-data',
  'optional-www-authenticate',
  'proxy-authenticate',
  'proxy-authentication-info',
  'public-key-pins',
  'sec-websocket-accept',
  'set-cookie',
  'set-cookie2',
  'setprofile',
  'strict-transport-security',
  'www-authenticate',
];

const VARIANT_HEADERS = [
  'variant-key-04',
  'variants-04',
];

const CERT_URL = `https://${WORKER_HOST}/cert`;
const VALIDITY_URL = `https://${HTML_HOST}/.sxg_validity`;

async function importWasmFunctions() {
  await wasm_bindgen(wasm);
  return wasm_bindgen;
}

async function handleRequestOnWorkerHost(request) {
  if (request.url === CERT_URL) {
    const {
      createCertCbor
    } = await importWasmFunctions();
    return new Response(
      createCertCbor(),
      {
        status: 200,
        headers: {
          'content-type': 'application/cert-chain+cbor',
        },
      },
    );
  } else {
    return new Response('Invalid path');
  }
}

async function handleRequestOnHtmlHost(request) {
  if (!acceptsSxg(request)) {
    return fetch(request);
  }
  const {
    url,
  } = request;
  const payload = await fetch(url);
  const payloadStatusCode = payload.status;
  if (payloadStatusCode !== 200) {
    return payload;
  }
  const payloadHeaders = Array.from(payload.headers).filter((entry) => {
    const key = entry[0].toLowerCase();
    return STATEFUL_HEADERS.includes(key) === false &&
      VARIANT_HEADERS.includes(key) === false &&
      UNCACHED_HEADERS.includes(key) === false;
  });
  const payloadBody = await payload.text();
  const {
    createSignedExchange,
  } = await importWasmFunctions();
  const sxg = createSignedExchange(
    CERT_URL,
    VALIDITY_URL,
    url,
    payloadStatusCode,
    payloadHeaders,
    payloadBody,
    Math.round(Date.now() / 1000 - 60 * 60 * 12),
  );
  return new Response(
      sxg,
      {
        status: 200,
        headers: {
          'Content-Type': 'application/signed-exchange;v=b3',
          'X-Content-Type-Options': 'nosniff',
        },
      },
  );
}

async function handleRequest(request) {
  const requestHost = (new URL(request.url)).host;
  if (requestHost === WORKER_HOST) {
    return await handleRequestOnWorkerHost(request);
  } else if (requestHost === HTML_HOST) {
    return await handleRequestOnHtmlHost(request);
  } else {
    return new Response(`Invalid host name. Did you set HTML_HOST and WORKER_HOST in wrangler.toml?`);
  }
}
