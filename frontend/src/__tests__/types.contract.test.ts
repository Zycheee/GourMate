/**
 * Contract guard: `src/types.ts` union members must exactly match the golden
 * manifest `contracts/ws-events.json` (architecture §7 / §9.2 / §11).
 *
 * The test parses `types.ts` with the TypeScript compiler API at runtime, so a
 * renamed/added/removed event, tool or error code fails CI on the frontend side
 * just as `backend/tests/test_protocol.py` fails on the backend side.
 */
import { describe, expect, it } from "vitest";
import * as ts from "typescript";
import goldenRaw from "../../../contracts/ws-events.json?raw";
import typesSource from "../types.ts?raw";

// The golden manifest is imported raw so this test needs no filesystem APIs and
// is bundled by Vite like any other module.
const GOLDEN = JSON.parse(goldenRaw) as {
  client_to_server: string[];
  server_to_client: string[];
  tool_names: string[];
  error_codes: string[];
  voice_states: string[];
};

const SOURCE = ts.createSourceFile(
  "types.ts",
  typesSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS
);

function findTypeAlias(name: string): ts.TypeAliasDeclaration {
  let found: ts.TypeAliasDeclaration | undefined;
  SOURCE.forEachChild((node) => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === name) {
      found = node;
    }
  });
  if (!found) {
    throw new Error(`types.ts is missing type alias "${name}"`);
  }
  return found;
}

function unwrapUnion(node: ts.TypeNode): ts.TypeNode[] {
  if (ts.isParenthesizedTypeNode(node)) {
    return unwrapUnion(node.type);
  }
  if (ts.isUnionTypeNode(node)) {
    return node.types.flatMap(unwrapUnion);
  }
  return [node];
}

/** String literals from a `"a" | "b"` union type node. */
function stringLiterals(node: ts.TypeNode): string[] {
  const out: string[] = [];
  for (const member of unwrapUnion(node)) {
    if (ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal)) {
      out.push(member.literal.text);
    } else {
      throw new Error(
        `Expected a string-literal union member, got ${ts.SyntaxKind[member.kind]}`
      );
    }
  }
  return out;
}

/** The `type` discriminator values from a discriminated-union type alias. */
function discriminatorValues(aliasName: string): string[] {
  const alias = findTypeAlias(aliasName);
  return unwrapUnion(alias.type).map((member) => {
    if (!ts.isTypeLiteralNode(member)) {
      throw new Error(`Expected a type literal in "${aliasName}"`);
    }
    const typeProp = member.members.find(
      (m): m is ts.PropertySignature =>
        ts.isPropertySignature(m) &&
        m.name !== undefined &&
        ts.isIdentifier(m.name) &&
        m.name.text === "type"
    );
    if (!typeProp?.type) {
      throw new Error(`"${aliasName}" member is missing a "type" property`);
    }
    const values = stringLiterals(typeProp.type);
    if (values.length !== 1) {
      throw new Error(`"${aliasName}" type discriminator must be a single literal`);
    }
    return values[0];
  });
}

function sorted(values: string[]): string[] {
  return [...values].sort();
}

describe("types.ts ↔ contracts/ws-events.json", () => {
  it("ServerMessage types exactly match the §7 server→client list", () => {
    expect(sorted(discriminatorValues("ServerMessage"))).toEqual(
      sorted(GOLDEN.server_to_client)
    );
  });

  it("ClientMessage types exactly match the §7 client→server list", () => {
    expect(sorted(discriminatorValues("ClientMessage"))).toEqual(
      sorted(GOLDEN.client_to_server)
    );
  });

  it("ToolName members exactly match the §9.2 tool registry", () => {
    expect(sorted(stringLiterals(findTypeAlias("ToolName").type))).toEqual(
      sorted(GOLDEN.tool_names)
    );
  });

  it("ErrorCode members exactly match the §11 taxonomy", () => {
    expect(sorted(stringLiterals(findTypeAlias("ErrorCode").type))).toEqual(
      sorted(GOLDEN.error_codes)
    );
  });

  it("ServerVoiceState members exactly match the §7 voice states", () => {
    expect(sorted(stringLiterals(findTypeAlias("ServerVoiceState").type))).toEqual(
      sorted(GOLDEN.voice_states)
    );
  });

  it("has no duplicate union members", () => {
    for (const [name, values] of [
      ["ServerMessage", discriminatorValues("ServerMessage")],
      ["ClientMessage", discriminatorValues("ClientMessage")],
      ["ToolName", stringLiterals(findTypeAlias("ToolName").type)],
      ["ErrorCode", stringLiterals(findTypeAlias("ErrorCode").type)]
    ] as [string, string[]][]) {
      expect(new Set(values).size, `${name} has duplicates`).toBe(values.length);
    }
  });
});
