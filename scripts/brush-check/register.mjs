// Lets Node run the app's TypeScript sources directly (see hooks.mjs).
import { register } from "node:module";

register("./hooks.mjs", import.meta.url);
