import { useSession } from "../store/session";
import { useCallback, useState } from "react";
import FoodPreviewModal from "./FoodPreviewModal";
import type { ChoiceOption, ConversationAction } from "../types";

/** One transient set of actions offered by the chef, beneath the current assistant reply. */
export default function ContextChoices({ onSendText, onSendAction }: { onSendText: (text: string) => void; onSendAction?: (action: ConversationAction, displayText?: string) => void }) {
  const choices = useSession((s) => s.choices);
  const setChoices = useSession((s) => s.setChoices);
  // A preview belongs to one exact choices event; replacement invalidates it.
  const [preview, setPreview] = useState<{ choice: ChoiceOption; options: ChoiceOption[] } | null>(null);
  const closePreview = useCallback(() => setPreview(null), []);
  const submit = (choice: ChoiceOption) => {
    closePreview();
    setChoices(null);
    if (choice.action && onSendAction) onSendAction(choice.action, choice.label);
    else onSendText(choice.submit_text ?? choice.label);
  };
  if (!choices?.length) return null;
  return <div className="context-choices" role="group" aria-label="Reply options" aria-live="polite">
    <div className="flex flex-wrap gap-2">{choices.map((choice) =>
      <button key={choice.id} type="button" className="clay-control rounded-full px-3 py-2 text-12 text-ink"
        onClick={() => choice.food ? setPreview({ choice, options: choices }) : submit(choice)}>{choice.label}{choice.food && <span className="ml-2 opacity-60" aria-hidden="true">↗</span>}</button>
    )}</div>
    {preview?.options === choices && <FoodPreviewModal choice={preview.choice} onClose={closePreview} onChoose={() => submit(preview.choice)} />}
  </div>;
}
