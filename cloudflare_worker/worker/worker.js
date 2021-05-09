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

const wasmFunctionsPromise = (async function initWasmFunctions() {
  await wasm_bindgen(wasm);
  wasm_bindgen.init();
  return wasm_bindgen;
})();

function responseFromWasm(data) {
  return new Response(
    new Uint8Array(data.body),
    {
      status: data.status,
      headers: data.headers,
    },
  );
}

/**
 * Consumes the input stream, and returns an byte array containing the data in
 * the input stream. If the input stream contains more bytes than `maxSize`,
 * returns null.
 * @param {ReadableStream} inputStream
 * @param {number} maxSize
 * @returns {Promise<Uint8Array | null>}
 */
async function readIntoArray(inputStream, maxSize) {
  const reader = inputStream.getReader();
  const received = new Uint8Array(maxSize);
  let receivedSize = 0;
  while (true) {
    const {
      value,
      done,
    } = await reader.read();
    if (value) {
      if (receivedSize + value.byteLength > maxSize) {
        reader.releaseLock();
        inputStream.cancel();
        return null;
      }
      received.set(value, receivedSize);
      receivedSize += value.byteLength;
    }
    if (done) {
      return received.subarray(0, receivedSize);
    }
  }
}

function teeResponse(response) {
  const {
    body,
    headers,
    status,
  } = response;
  const [body1, body2] = response.body.tee();
  return [
      new Response(body1, { headers, status }),
      new Response(body2, { headers, status }),
  ];
}

async function handleRequest(request) {
  const {
    createRequestHeaders,
    getLastErrorMessage,
    servePresetContent,
    shouldRespondDebugInfo,
  } = await wasmFunctionsPromise;
  let fallback = null;
  try {
    const presetContent = servePresetContent(request.url);
    if (presetContent) {
      return responseFromWasm(presetContent);
    }
    const requestHeaders = createRequestHeaders(Array.from(request.headers));
    let sxgPayload;
    [sxgPayload, fallback] = teeResponse(await fetch(
      request.url,
      {
        headers: requestHeaders,
      }
    ));
    return await generateSxgResponse(request, sxgPayload);
  } catch (e) {
    if (shouldRespondDebugInfo()) {
      let message;
      if (e instanceof WebAssembly.RuntimeError) {
        message = `WebAssembly code is aborted.\n${e}.\n${getLastErrorMessage()}`;
      } else if (typeof e === 'string') {
        message = `A message is gracefully thrown.\n${e}`;
      } else {
        message = `JavaScript code throws an error.\n${e}`;
      }
      if (!fallback) {
        fallback = new Response(message);
      }
      return new Response(
        fallback.body,
        {
          status: fallback.status,
          headers: [
              ...Array.from(fallback.headers || []),
              ['sxg-edge-worker-debug-info', JSON.stringify(message)],
          ],
        },
      );
    } else {
      if (fallback) {
        // The error occurs after fetching from origin server, hence we reuse
        // the response of that fetch.
        return fallback;
      } else {
        // The error occurs before fetching from origin server, hence we need to
        // fetch now. Since we are not generating SXG anyway in this case, we
        // simply use all http headers from the user.
        return fetch(request);
      }
    }
  }
}

async function generateSxgResponse(request, payload) {
  const {
    createSignedExchange,
    validatePayloadHeaders,
  } = await wasmFunctionsPromise;
  const payloadStatusCode = payload.status;
  if (payloadStatusCode !== 200) {
    throw `The resource status code is ${payloadStatusCode}`;
  }
  const payloadHeaders = Array.from(payload.headers);
  validatePayloadHeaders(payloadHeaders);
  const PAYLOAD_SIZE_LIMIT = 8000000;
  const payloadBody = await readIntoArray(payload.body, PAYLOAD_SIZE_LIMIT);
  if (!payloadBody) {
    throw `The size of payload exceeds the limit ${PAYLOAD_SIZE_LIMIT}`;
  }
  const sxg = await createSignedExchange(
    request.url,
    payloadStatusCode,
    payloadHeaders,
    new Uint8Array(payloadBody),
    Math.round(Date.now() / 1000 - 60 * 60 * 12),
    signer,
  );
  return new responseFromWasm(sxg);
}

const privateKeyPromise = (async function initPrivateKey() {
    if (!PRIVATE_KEY_JWK) {
      throw `The wrangler secret PRIVATE_KEY_JWK is not set.`;
    }
    return await crypto.subtle.importKey(
        "jwk",
        JSON.parse(PRIVATE_KEY_JWK),
        {
          name: "ECDSA",
          namedCurve: 'P-256',
        },
        /*extractable=*/false,
        ['sign'],
    );
})();

async function signer(message) {
  const privateKey = await privateKeyPromise;
  const signature = await crypto.subtle.sign(
      {
        name: "ECDSA",
        hash: 'SHA-256',
      },
      privateKey,
      message,
  );
  return new Uint8Array(signature);
}
