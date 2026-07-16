import { StrictMode } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { Counter } from "./Counter";

const selector = "[data-react-counter-root]";
const roots = new Map<Element, Root>();

function hydrateCounters(parent: ParentNode = document) {
  if (parent instanceof Element && parent.matches(selector)) hydrateCounter(parent);
  for (const element of parent.querySelectorAll(selector)) hydrateCounter(element);
}

function hydrateCounter(element: Element) {
  if (roots.has(element)) return;
  const root = hydrateRoot(
    element,
    <StrictMode>
      <Counter />
    </StrictMode>,
  );
  roots.set(element, root);
  (element as HTMLElement).dataset.reactHydrated = "true";
}

hydrateCounters();

new MutationObserver((records) => {
  for (const record of records) {
    for (const node of record.addedNodes) {
      if (node instanceof Element) hydrateCounters(node);
    }
  }

  for (const [element, root] of roots) {
    if (!element.isConnected) {
      root.unmount();
      roots.delete(element);
    }
  }
}).observe(document, { childList: true, subtree: true });
