/**
 * @externs
 * @fileoverview Minimal test-only definition for module "fs".
 */
var fs = {};

/**
 * @param {string} filename
 * @param {*} data
 * @param {{encoding: string, mode: string, flag: string}=} options
 * @return {void}
 */
fs.writeFileSync = function(filename, data, options) {};
