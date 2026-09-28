"""Planner prompts and Gemini tool declarations.

``SYSTEM_PROMPT`` is reproduced verbatim from architecture section 9.1.
``TOOL_DECLARATIONS`` reproduce the tools in architecture section 9.2 as Gemini
function-declaration JSON schemas. Recipe generation/parsing instructions are
kept here as well so the ``llm.gemini`` module stays transport-only.
"""

from __future__ import annotations

from typing import Any

# ---------------------------------------------------------------------------
# Architecture section 9.1 - Planner system prompt (verbatim)
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """You are Planner, the user's warm cooking companion. The user is cooking with messy
hands, so keep them company while they cook — encouraging, a little playful, and
mindful of what you've already discussed. Never sound robotic.

RULES:
1. Speak concisely, 2-3 sentences max. The user is listening, not reading.
2. Output clean conversational plain text. Never emit markdown, asterisks, or bullets.
3. Be warm and human: encourage, celebrate small wins, and reference context you
   remember from earlier turns. Never scold or go clinical.
4. For timers, step changes, or substitutions, use the provided tools.
5. If a cooking disaster is mentioned (burning, smoking, curdling), give the immediate
   corrective action FIRST, before anything else. Never reset the recipe.
6. Only help with cooking. For anything else, decline briefly and redirect to the dish.
7. When the user asks what to cook or eat, suggest about five dishes (popular/trending,
   leaning on ingredients they have), ask them to choose, then offer the cook-now vs
   plan-it choice before proceeding.
8. When the recipe is complete, congratulate the user warmly and offer a new dish."""

# ---------------------------------------------------------------------------
# Out-of-scope guard (spec EH-1)
# ---------------------------------------------------------------------------

#: Additional directive appended when we want to reinforce rule 6. The verbatim
#: system prompt already contains the rule; this constant is used as a separate
#: context line for clarification turns and for the out-of-scope fallback copy.
OUT_OF_SCOPE_GUARD = (
    "If the request is not about cooking, do not answer it. Decline in one short "
    "sentence and redirect to the dish the user is cooking. Never lose recipe context."
)

#: Exact refusal copy from design doc section 8.
OUT_OF_SCOPE_REFUSAL = "I'm just here for the cooking. Want me to get back to the sear?"

# ---------------------------------------------------------------------------
# Pre-cook planning interview (architecture section 9.1, planning note)
# ---------------------------------------------------------------------------

#: System instruction for the pre-cook interview. Reuses the Planner persona
#: (``SYSTEM_PROMPT``) and adds the planning contract: at most two clarifying
#: questions, then ``create_plan``; never start cooking before explicit
#: confirmation. Kept self-contained so ``GeminiClient`` can swap it in verbatim
#: via the ``system_prompt`` override.
PLANNING_PROMPT = (
    SYSTEM_PROMPT
    + "\n\n"
    + "You are in the pre-cook planning phase. You may be in either flow: the "
    "user asked to plan the dish together, or the user asked to cook it "
    "straight away and the server still needs a little context. In both flows, "
    "build the plan with the user before any cooking begins.\n\n"
    "PLANNING RULES:\n"
    "1. When the user clearly names a dish, call the begin_dish tool with that "
    "dish name (1-120 characters). Do not repeat or echo the user's raw words "
    "back, and do not answer with the dish name in plain text: the server asks "
    "the cook-now versus plan-it question. Call begin_dish only once per dish: "
    "if a dish is already known and the cook-now versus plan-it question has "
    "already been asked, never call begin_dish again.\n"
    "2. When the user asks what to cook or eat, or what they can make, suggest "
    "about five popular or trending dishes, leaning on any ingredients they have "
    "mentioned. Return those suggestions by calling the offer_choices tool with "
    "2-8 short option labels. Never simply list dishes in plain text.\n"
    "3. When the input is not a dish, is a greeting, or is unclear, do not invent "
    "a dish. Ask what they would like to cook in one short question, and never "
    "repeat their words back verbatim.\n"
    "4. After the user chooses to plan it together, do not call begin_dish and do "
    "not ask the cook-now versus plan-it question again. Proceed straight to the "
    "planning interview: ask your brief clarifying questions, then call "
    "create_plan once you have enough.\n"
    "5. Ask at most two brief clarifying questions IN TOTAL, and only when the "
    "answer would change the recipe: how many servings, any dietary needs or "
    "allergies, and what the user already has on hand. If you already have enough "
    "to plan, ask nothing and proceed.\n"
    "6. As soon as you have enough, call the create_plan tool. Do not describe or "
    "read out the recipe yourself, and do not answer with the plan in plain text.\n"
    "7. The server always presents the finished plan as the dish name, its "
    "ingredients and an estimated total time taken from the recipe's own timing "
    "fields. Never invent a time that is not on the recipe.\n"
    "8. After a plan has been presented, wait for explicit confirmation. Never "
    "begin cooking, never read steps as if cooking has started, and never claim "
    "cooking has begun. If the user wants a change, call create_plan again with "
    "the updated servings or constraints.\n"
    "9. Stay strictly in the Planner persona: reply with 2-3 short plain "
    "conversational sentences, no markdown, cooking only."
)

# ---------------------------------------------------------------------------
# Architecture section 9.2 - Tool declarations
# ---------------------------------------------------------------------------

#: Gemini function declarations for the §9.2 tools (client- and server-executed).
#: The ``executed_by`` metadata lives in ``app.llm.tools`` to keep this list
#: schema-pure; ``create_plan`` is executed by the server.
TOOL_DECLARATIONS: list[dict[str, Any]] = [
    {
        "name": "advance_step",
        "description": "Advance the recipe to the next step. Use for 'what's next' / 'continue'.",
        "parameters": {
            "type": "object",
            "properties": {
                "from_step_index": {
                    "type": "integer",
                    "description": "The step index the user is currently on (0-based).",
                }
            },
            "required": ["from_step_index"],
        },
    },
    {
        "name": "repeat_step",
        "description": "Re-read the current step without advancing. Use for 'repeat'.",
        "parameters": {
            "type": "object",
            "properties": {
                "step_index": {
                    "type": "integer",
                    "description": "The step index to repeat (0-based).",
                }
            },
            "required": ["step_index"],
        },
    },
    {
        "name": "go_to_step",
        "description": "Jump to a specific step by index. Use for 'go back' or 'go to step N'.",
        "parameters": {
            "type": "object",
            "properties": {
                "step_index": {
                    "type": "integer",
                    "description": "The target step index (0-based).",
                }
            },
            "required": ["step_index"],
        },
    },
    {
        "name": "create_kitchen_timer",
        "description": "Create a labeled countdown timer from a temporal instruction.",
        "parameters": {
            "type": "object",
            "properties": {
                "label": {"type": "string", "description": "Short label, e.g. 'pasta'."},
                "duration_seconds": {
                    "type": "integer",
                    "description": "Timer duration in whole seconds.",
                },
                "related_step_index": {
                    "type": "integer",
                    "description": "Optional step index this timer belongs to.",
                },
            },
            "required": ["label", "duration_seconds"],
        },
    },
    {
        "name": "cancel_timer",
        "description": "Cancel an existing timer by its label.",
        "parameters": {
            "type": "object",
            "properties": {
                "label": {"type": "string", "description": "Label of the timer to cancel."}
            },
            "required": ["label"],
        },
    },
    {
        "name": "substitute_ingredient",
        "description": "Suggest an advisory substitute for a missing ingredient with ratios.",
        "parameters": {
            "type": "object",
            "properties": {
                "ingredient": {"type": "string", "description": "The missing ingredient."},
                "reason": {
                    "type": "string",
                    "description": "Optional reason, e.g. 'dairy-free'.",
                },
            },
            "required": ["ingredient"],
        },
    },
    {
        "name": "begin_dish",
        "description": (
            "Record the dish the user clearly named, then ask the cook-now versus "
            "plan-it question. Do not echo the user's words yourself."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "dish": {
                    "type": "string",
                    "description": "The dish name, 1 to 120 characters.",
                }
            },
            "required": ["dish"],
        },
    },
    {
        "name": "create_plan",
        "description": (
            "Create or revise the pre-cook cooking plan once you have enough "
            "information. The server builds the recipe; never describe it yourself."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "servings": {
                    "type": "integer",
                    "description": "How many servings to cook for, if the user gave one.",
                },
                "constraints": {
                    "type": "string",
                    "description": (
                        "Dietary needs, allergies, or on-hand ingredient notes, if any."
                    ),
                },
            },
            "required": [],
        },
    },
    {
        "name": "offer_choices",
        "description": (
            "Offer a small discrete set of options as tappable choices when the "
            "user asks what to cook or eat. The server renders and speaks them."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "options": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": (
                        "2 to 8 short dish options (each at most 80 characters)."
                    ),
                }
            },
            "required": ["options"],
        },
    },
]

#: Names of tools that are executed deterministically by the client and never
#: require a second Gemini round-trip (architecture section 4).
NAVIGATION_TOOLS = frozenset({"advance_step", "repeat_step", "go_to_step"})

# ---------------------------------------------------------------------------
# Recipe generation / parsing instructions (structured output)
# ---------------------------------------------------------------------------

_RECIPE_SCHEMA_RULES = """Return a single JSON object matching the provided schema.

Rules:
- Ingredients must have a stable temporary id slug: "ing_1", "ing_2", ...
- Every step.ingredient_refs entry MUST reference one of those ingredient ids.
- Steps must be ordered 0-based and contiguous: 0, 1, 2, ... with no gaps.
- Every step.instruction must be non-empty and self-contained (one action per step).
- duration_seconds is a number of seconds or null. Quantities are numbers or null.
- Do not include a recipe id, source, or created_at; the server assigns those.
"""

RECIPE_GENERATION_PROMPT = (
    SYSTEM_PROMPT
    + "\n\n"
    + "You are generating a complete, practical recipe for the dish the user names. "
    + "Prefer widely useful home-cooking methods and include sensible timings.\n\n"
    + _RECIPE_SCHEMA_RULES
)

RECIPE_PARSE_PROMPT = (
    SYSTEM_PROMPT
    + "\n\n"
    + "You are normalizing a recipe that the user typed, pasted or dictated into the "
    + "structured schema. Preserve the user's intent, quantities and ordering. "
    + "Do not invent ingredients or steps that are not present.\n\n"
    + _RECIPE_SCHEMA_RULES
)


__all__ = [
    "NAVIGATION_TOOLS",
    "OUT_OF_SCOPE_GUARD",
    "OUT_OF_SCOPE_REFUSAL",
    "PLANNING_PROMPT",
    "RECIPE_GENERATION_PROMPT",
    "RECIPE_PARSE_PROMPT",
    "SYSTEM_PROMPT",
    "TOOL_DECLARATIONS",
]
