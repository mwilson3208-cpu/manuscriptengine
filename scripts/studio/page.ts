import { readFileSync } from "node:fs";

/** The Studio's single page: plain HTML, CSS, and JavaScript, no build step and no dependencies. */
export const STUDIO_PAGE = readFileSync(new URL("./page.html", import.meta.url), "utf8");
