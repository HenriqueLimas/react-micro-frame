import { initEmbedded } from "marko/debug/dom";

// Importing the interactive Marko template registers its browser-side
// closures with the Marko runtime data streamed by the server render.
import "./fragment.marko";

initEmbedded("src/fragment.marko");
