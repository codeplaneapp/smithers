import { readFileSync } from "node:fs";
import { oneshotConfigPath } from "./oneshotConfigPath.js";

/** @typedef {{ review: "on" | "off" | null; trivial: "direct" | "oneshot" | null; announced: boolean }} OneshotConfig */

/** @param {NodeJS.ProcessEnv} [env] @returns {OneshotConfig} */
export function loadOneshotConfig(env = process.env) {
    try {
        const parsed = JSON.parse(readFileSync(oneshotConfigPath(env), "utf8"));
        const oneshot = parsed?.oneshot;
        return {
            review: oneshot?.review === "on" || oneshot?.review === "off" ? oneshot.review : null,
            trivial: oneshot?.trivial === "direct" || oneshot?.trivial === "oneshot" ? oneshot.trivial : null,
            announced: oneshot?.announced === true,
        };
    }
    catch {
        return { review: null, trivial: null, announced: false };
    }
}
