/**
 * Decode the actual multipart wire representation passed to an injectable
 * Fetch transport. The shared HTTP client serializes FormData once through a
 * Request, then forwards that encoded stream with its matching boundary.
 *
 * @param {RequestInit} init
 */
export async function readMultipartWireBody(init) {
    const headers = new Headers(init.headers);
    return {
        body: init.body,
        contentType: headers.get("content-type"),
        form: await new Response(init.body, { headers }).formData(),
    };
}
