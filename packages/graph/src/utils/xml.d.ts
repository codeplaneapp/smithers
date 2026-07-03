import { XmlNode as XmlNode$1 } from '../types.js';
import 'zod';

/**
 * @param {XmlNode | null} node
 * @returns {string}
 */
declare function canonicalizeXml(node: XmlNode | null): string;
/**
 * @param {string} json
 * @returns {XmlNode | null}
 */
declare function parseXmlJson(json: string): XmlNode | null;
type XmlNode = XmlNode$1;

export { type XmlNode, canonicalizeXml, parseXmlJson };
