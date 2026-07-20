import { useState } from "react";

export function Counter() {
  const [count, setCount] = useState(0);

  return (
    <div className="counter" aria-label="React fragment counter">
      <button
        type="button"
        data-counter-decrement
        aria-label="Decrement React counter"
        onClick={() => setCount((value) => value - 1)}
      >
        −
      </button>
      <output data-counter-output aria-live="polite">
        {count}
      </output>
      <button
        type="button"
        data-counter-increment
        aria-label="Increment React counter"
        onClick={() => setCount((value) => value + 1)}
      >
        +
      </button>
    </div>
  );
}
