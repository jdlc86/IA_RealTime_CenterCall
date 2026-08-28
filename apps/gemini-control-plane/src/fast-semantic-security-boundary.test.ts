import { describe, expect, it } from "vitest";
import {
  FAST_SEMANTIC_SECURITY_CATEGORIES,
  FAST_SEMANTIC_SECURITY_TOOL,
  FAST_SEMANTIC_SECURITY_TOOL_NAME,
  fastSemanticSecurityInstruction,
} from "./fast-semantic-security-boundary";

describe("Fast semantic security boundary", () => {
  it("declares a minimal category-only semantic proposal tool", () => {
    expect(FAST_SEMANTIC_SECURITY_TOOL.name).toBe(FAST_SEMANTIC_SECURITY_TOOL_NAME);
    expect(FAST_SEMANTIC_SECURITY_TOOL.parameters).toEqual({
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: [...FAST_SEMANTIC_SECURITY_CATEGORIES],
        },
      },
      required: ["category"],
      additionalProperties: false,
    });
    expect(FAST_SEMANTIC_SECURITY_TOOL.description).toContain("intención y contexto completo");
    expect(FAST_SEMANTIC_SECURITY_TOOL.description).toContain("preguntas educativas generales");
    expect(FAST_SEMANTIC_SECURITY_TOOL.description).toContain("sólo propone un incidente");
  });

  it("keeps semantic authority model-owned without rigid lexical rules", () => {
    const instruction = fastSemanticSecurityInstruction();
    expect(instruction).toContain("significado completo y el contexto del turno");
    expect(instruction).toContain("No decidas por keywords, frases rígidas o coincidencias léxicas");
    expect(instruction).toContain("no es por sí misma un incidente");
    expect(instruction).toContain("No te autoriza a bloquear permanentemente");
  });
});
