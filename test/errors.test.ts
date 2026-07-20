import { describe, expect, it } from "vitest";
import {
  MicroFrameError,
  MicroFrameHttpError,
  MicroFrameTimeoutError,
} from "../src";

describe("public errors", () => {
  it("preserves micro-frame context and causes", () => {
    const cause = new Error("network");
    const error = new MicroFrameError("failed", "/remote", { cause });

    expect(error).toMatchObject({
      name: "MicroFrameError",
      message: "failed",
      src: "/remote",
      cause,
    });
  });

  it("formats HTTP errors with and without status text", () => {
    expect(new MicroFrameHttpError("/remote", 404, "Not Found")).toMatchObject({
      name: "MicroFrameHttpError",
      message: "Micro-frame request failed with 404 Not Found: /remote",
      src: "/remote",
      status: 404,
      statusText: "Not Found",
    });
    expect(new MicroFrameHttpError("/remote", 500, "").message).toBe(
      "Micro-frame request failed with 500: /remote",
    );
  });

  it("reports timeout duration and source", () => {
    expect(new MicroFrameTimeoutError("/slow", 250)).toMatchObject({
      name: "MicroFrameTimeoutError",
      message: "Micro-frame request timed out after 250ms: /slow",
      src: "/slow",
      timeout: 250,
    });
  });
});
