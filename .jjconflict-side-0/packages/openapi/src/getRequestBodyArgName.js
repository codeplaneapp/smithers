/**
 * @param {import("./ParameterObject.ts").ParameterObject[]} parameters
 * @returns {string}
 */
export function getRequestBodyArgName(parameters) {
    const parameterNames = new Set(parameters
        .filter((param) => param.in !== "cookie")
        .map((param) => param.name));
    if (!parameterNames.has("body")) {
        return "body";
    }
    let requestBodyArgName = "requestBody";
    while (parameterNames.has(requestBodyArgName)) {
        requestBodyArgName = `_${requestBodyArgName}`;
    }
    return requestBodyArgName;
}
