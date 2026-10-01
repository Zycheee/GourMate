import { useSession } from "../store/session";
import { UI } from "../lib/copy";

/** One transient set of actions offered by the chef, wherever the active panel lives. */
export default function ContextChoices({ onSendText }: { onSendText: (text: string) => void }) {
  const choices = useSession((s) => s.choices);
  const setChoices = useSession((s) => s.setChoices);
  if (!choices?.length) return null;
  return <div className="context-choices" role="group" aria-label={UI.choicesLabel} aria-live="polite">
    <p className="text-11 text-ink-muted mb-2">{UI.choicesLabel}</p>
    <div className="flex flex-wrap gap-2">{choices.map((choice) =>
      <button key={choice.id} type="button" className="clay-control rounded-full px-3 py-2 text-12 text-ink"
        onClick={() => { setChoices(null); onSendText(choice.label); }}>{choice.label}</button>
    )}</div>
  </div>;
}
