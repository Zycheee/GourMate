import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ChoiceOption, FoodImageResponse } from "../types";
import { httpBaseUrl } from "../lib/ws";

export default function FoodPreviewModal({ choice, onClose, onChoose }: {
  choice: ChoiceOption;
  onClose: () => void;
  onChoose: () => void;
}) {
  const food = choice.food!;
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [imageFailed, setImageFailed] = useState(false);
  const [photo, setPhoto] = useState<FoodImageResponse | null>(null);
  const [loading, setLoading] = useState(!food.image_url);
  useEffect(() => {
    const controller = new AbortController();
    setPhoto(null); setImageFailed(false);
    if (food.image_url) { setLoading(false); return; }
    setLoading(true);
    const timeout = window.setTimeout(() => { controller.abort(); setLoading(false); }, 5500);
    void fetch(`${httpBaseUrl()}/api/food-images/lookup`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dish: food.name }), signal: controller.signal
    }).then(async response => {
      if (response.ok) {
        const result: FoodImageResponse = await response.json();
        if (!controller.signal.aborted) setPhoto(result);
      }
    }).catch(() => { /* Text details remain available without a photo. */ })
      .finally(() => { window.clearTimeout(timeout); if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); window.clearTimeout(timeout); };
  }, [food.name, food.image_url]);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const dialog = dialogRef.current;
    dialog?.querySelector<HTMLButtonElement>("button")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
      if (event.key === "Tab" && dialog) {
        const items = Array.from(dialog.querySelectorAll<HTMLElement>("button, a[href], [tabindex='0']"));
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault(); last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault(); first?.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      if (opener?.isConnected) opener.focus();
    };
  }, [onClose]);

  const image = photo ?? food;
  const path = image.image_url && /^https:\/\/(upload|thumb)\.wikimedia\.org\//.test(image.image_url) ? image.image_url : null;
  return createPortal(
    <div className="food-preview-backdrop" onClick={onClose}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId}
        className="food-preview clay-strong" onClick={(event) => event.stopPropagation()}>
        <button type="button" className="food-preview-close clay-control" aria-label="Close food preview" onClick={onClose}>×</button>
        {path && !imageFailed
          ? <img className="food-preview-image" src={path} alt={food.name} referrerPolicy="no-referrer" onError={() => setImageFailed(true)} />
          : <div className="food-preview-image food-preview-placeholder" role="status">{loading ? "Finding a photo…" : "Image unavailable"}</div>}
        <div className="food-preview-content">
          <h2 id={titleId}>{food.name}</h2>
          <p>{food.description}</p>
          <div className="food-preview-meta">
            <span>{food.estimated_total_minutes != null ? `Estimated total: ${food.estimated_total_minutes} min` : "Cooking time available with recipe"}</span>
            <span>{food.difficulty}</span>
          </div>
          <h3>Why it’s popular</h3><p>{food.popularity}</p>
          <h3>Why it fits</h3><p>{food.fit}</p>
          <h3>Key ingredients</h3><p>{food.key_ingredients.join(", ")}</p>
          {path && image.image_credit && <p className="food-preview-credit">
            Photo: {image.image_credit}{" · "}
            {image.image_source?.startsWith("https://commons.wikimedia.org/")
              ? <a href={image.image_source} target="_blank" rel="noreferrer">{image.image_license} · Source</a>
              : image.image_license}
          </p>}
          <div className="food-preview-actions">
            <button type="button" className="clay-control" onClick={onChoose}>Choose this dish</button>
            <button type="button" className="clay-control" onClick={onClose}>Back to options</button>
          </div>
        </div>
      </div>
    </div>, document.body
  );
}
