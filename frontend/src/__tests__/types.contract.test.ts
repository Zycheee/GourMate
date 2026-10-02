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
  activity: { required: string[] };
  action_names: string[];
  conversation_action: { required: string[]; optional: string[] };
  utterance_identity: { optional_field: string; events: string[] };
  pending_audio_policies: string[];
  control_optional: string[];
  control_actions: string[];
  reply_identity: { optional_field: string; events: string[] };
  client_to_server: string[];
  server_to_client: string[];
  tool_names: string[];
  error_codes: string[];
  voice_states: string[];
  choice_option: { required: string[]; optional: string[] };
  food_preview: { required: string[]; optional: string[]; difficulty: string[] };
  food_image_lookup: { request_required: string[]; response_required: string[] };
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
  it("activity, controls and optional reply identity match the manifest", () => {
    const members = (alias: string) => unwrapUnion(findTypeAlias(alias).type).map(n => {
      if (!ts.isTypeLiteralNode(n)) throw new Error("Expected event object");
      return n.members.filter(ts.isPropertySignature);
    });
    const event = (alias: string, name: string) => members(alias).find(props => props.some(p => p.name.getText(SOURCE) === "type" && p.type && stringLiterals(p.type)[0] === name))!;
    const activity = event("ServerMessage", "activity").filter(p => p.name.getText(SOURCE) !== "type");
    expect(sorted(activity.map(p => p.name.getText(SOURCE)))).toEqual(sorted(GOLDEN.activity.required));
    expect(activity.every(p => !p.questionToken)).toBe(true);
    const controls = event("ClientMessage", "control");
    expect(sorted(controls.filter(p => p.questionToken).map(p => p.name.getText(SOURCE)))).toEqual(sorted(GOLDEN.control_optional));
    expect(sorted(stringLiterals(controls.find(p => p.name.getText(SOURCE) === "action")!.type!))).toEqual(sorted(GOLDEN.control_actions));
    const mutePolicy = controls.find(p => p.name.getText(SOURCE) === "pending_audio")!;
    expect(sorted(stringLiterals(mutePolicy.type!))).toEqual(sorted(GOLDEN.pending_audio_policies));
    for (const name of GOLDEN.utterance_identity.events) {
      expect(event("ServerMessage", name).find(p => p.name.getText(SOURCE) === GOLDEN.utterance_identity.optional_field)?.questionToken).toBeDefined();
    }
    for (const name of GOLDEN.reply_identity.events) {
      expect(event("ServerMessage", name).find(p => p.name.getText(SOURCE) === GOLDEN.reply_identity.optional_field)?.questionToken).toBeDefined();
    }
  });
  it("contextual actions match the manifest", () => {
    expect(sorted(stringLiterals(findTypeAlias("ActionName").type))).toEqual(sorted(GOLDEN.action_names));
    const node = findTypeAlias("ConversationAction").type;
    if (!ts.isTypeLiteralNode(node)) throw new Error("Expected action object");
    const properties = node.members.filter(ts.isPropertySignature);
    expect(sorted(properties.filter(p => !p.questionToken).map(p => p.name.getText(SOURCE)))).toEqual(sorted(GOLDEN.conversation_action.required));
    expect(sorted(properties.filter(p => p.questionToken).map(p => p.name.getText(SOURCE)))).toEqual(sorted(GOLDEN.conversation_action.optional));
  });
  it("photo lookup request and response match the REST manifest", () => {
    for (const [name, fields] of [["FoodImageRequest", GOLDEN.food_image_lookup.request_required], ["FoodImageResponse", GOLDEN.food_image_lookup.response_required]] as const) {
      const node = findTypeAlias(name).type;
      if (!ts.isTypeLiteralNode(node)) throw new Error(`${name} must be an object type`);
      const properties = node.members.filter(ts.isPropertySignature);
      expect(sorted(properties.map(p => p.name.getText(SOURCE)))).toEqual(sorted(fields));
      expect(properties.every(p => !p.questionToken)).toBe(true);
    }
  });
  it("choice and food fields, optionality, and difficulty match the §7 manifest", () => {
    for (const [name, shape] of [["ChoiceOption", GOLDEN.choice_option], ["FoodPreview", GOLDEN.food_preview]] as const) {
      const node = findTypeAlias(name).type;
      if (!ts.isTypeLiteralNode(node)) throw new Error(`${name} must be an object type`);
      const properties = node.members.filter(ts.isPropertySignature);
      expect(sorted(properties.filter(p => !p.questionToken).map(p => p.name.getText(SOURCE)))).toEqual(sorted(shape.required));
      expect(sorted(properties.filter(p => p.questionToken).map(p => p.name.getText(SOURCE)))).toEqual(sorted(shape.optional));
      if (name === "FoodPreview") {
        const difficulty = properties.find(p => p.name.getText(SOURCE) === "difficulty");
        expect(sorted(stringLiterals(difficulty!.type!))).toEqual(sorted(GOLDEN.food_preview.difficulty));
      }
    }
  });

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
