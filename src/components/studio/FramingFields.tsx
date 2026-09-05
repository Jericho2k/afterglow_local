"use client";

import { useCallback, useRef, useState } from "react";
import { Crosshair, ImagePlus, RotateCcw, Upload } from "lucide-react";
import { artPresentation, artStyle, type ArtPresentation, type FocalPoint } from "@/lib/art-presentation";
import { avatarSource, characterAvatarBucket } from "@/lib/storage";
import { uploadImage } from "@/lib/uploads";
import { Field } from "./fields";
import styles from "./studio.module.css";

/**
 * Choosing what survives the crop, by pointing at it.
 *
 * A creator uploads one image and Afterglow shows it as a 3:4 card, a small
 * near-square row and a wide hero. Something is cut in at least two of those,
 * and until now which part was cut was decided by a constant in a stylesheet
 * that had never seen the picture.
 *
 * The interaction is deliberately not a pair of number fields. A focal point is
 * a claim about a photograph — "her face, here" — and the only way to make that
 * claim accurately is to look at the photograph while making it. So the control
 * IS the image: click or drag on it, and the crops that will actually be used
 * update beside it as you do. Nobody types 0.42.
 *
 * Keyboard access is not an afterthought here, because a coordinate is exactly
 * the kind of value a pointer sets imprecisely: the target is focusable and the
 * arrow keys nudge it by a percent, which is finer than most people can drag.
 */

const nudge = 0.01;
const bigNudge = 0.1;

function clamp(value: number) {
  return Math.min(1, Math.max(0, value));
}

/** The pointer's position inside the element, as fractions. */
function pointIn(element: HTMLElement, clientX: number, clientY: number): FocalPoint {
  const box = element.getBoundingClientRect();
  return {
    x: clamp((clientX - box.left) / Math.max(1, box.width)),
    y: clamp((clientY - box.top) / Math.max(1, box.height)),
  };
}

function FocalPicker({ src, focal, onChange, label }: {
  src: string;
  focal: FocalPoint | undefined;
  onChange: (focal: FocalPoint) => void;
  label: string;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  // An unset focal point shows the marker in the middle without CLAIMING the
  // middle: `focal` stays undefined until the creator commits to a point, so
  // opening the picker and closing it again stores nothing.
  const shown = focal ?? { x: 0.5, y: 0.5 };

  const set = useCallback((clientX: number, clientY: number) => {
    if (frame.current) onChange(pointIn(frame.current, clientX, clientY));
  }, [onChange]);

  return <div
    ref={frame}
    className={styles.focalFrame}
    role="application"
    aria-label={label}
    tabIndex={0}
    onPointerDown={(event) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragging(true);
      set(event.clientX, event.clientY);
    }}
    onPointerMove={(event) => { if (dragging) set(event.clientX, event.clientY); }}
    onPointerUp={(event) => { event.currentTarget.releasePointerCapture(event.pointerId); setDragging(false); }}
    onKeyDown={(event) => {
      const step = event.shiftKey ? bigNudge : nudge;
      const moves: Record<string, FocalPoint> = {
        ArrowLeft: { x: clamp(shown.x - step), y: shown.y },
        ArrowRight: { x: clamp(shown.x + step), y: shown.y },
        ArrowUp: { x: shown.x, y: clamp(shown.y - step) },
        ArrowDown: { x: shown.x, y: clamp(shown.y + step) },
      };
      const next = moves[event.key];
      if (!next) return;
      event.preventDefault();
      onChange(next);
    }}
  >
    <img src={src} alt="" draggable={false} />
    <span
      className={styles.focalMarker}
      style={{ left: `${shown.x * 100}%`, top: `${shown.y * 100}%` }}
      aria-hidden
    ><Crosshair size={18} /></span>
  </div>;
}

/**
 * The crops, as they will actually appear.
 *
 * Three windows at the three shapes the product uses, fed by the same
 * `artStyle` the real surfaces call — so this is a preview of the rendering
 * code rather than an imitation of it, and the two cannot drift.
 */
function CropPreviews({ src, presentation, target }: { src: string; presentation: ArtPresentation; target: "cover" | "banner" }) {
  const shapes: { ratio: string; label: string }[] = target === "banner"
    ? [{ ratio: "16:9", label: "Desktop hero" }]
    : [{ ratio: "3:4", label: "Card" }, { ratio: "1:1", label: "Ranked row" }, { ratio: "16:9", label: "Hero" }];
  return <ul className={styles.cropPreviews}>
    {shapes.map((shape) => <li key={shape.ratio}>
      <span className={styles.cropWindow} data-ratio={shape.ratio}>
        <img src={src} alt="" style={artStyle(presentation, target, shape.ratio)} />
      </span>
      <small>{shape.label}</small>
    </li>)}
  </ul>;
}

export function FramingFields({ avatarPath, avatarUrl, bannerPath, bannerUrl, presentation, onChange, onError }: {
  avatarPath: string;
  avatarUrl: string;
  bannerPath: string;
  bannerUrl: string;
  presentation: ArtPresentation | undefined;
  onChange: (value: { bannerPath?: string; bannerUrl?: string; artPresentation?: ArtPresentation }) => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const current = artPresentation(presentation);
  const cover = avatarSource(characterAvatarBucket, avatarPath, avatarUrl);
  const banner = avatarSource(characterAvatarBucket, bannerPath, bannerUrl);

  function setFocal(target: "cover" | "banner", focal: FocalPoint) {
    onChange({ artPresentation: { ...current, [target]: { focal } } });
  }
  function clearFocal(target: "cover" | "banner") {
    const next = { ...current };
    delete next[target];
    onChange({ artPresentation: next });
  }

  async function uploadBanner(file: File) {
    setBusy(true);
    try { onChange({ bannerPath: await uploadImage(file, characterAvatarBucket) }); }
    catch (error) { onError(error instanceof Error ? error.message : "Image upload failed"); }
    finally { setBusy(false); }
  }

  return <>
    {cover && <Field
      label="Framing"
      optional
      hint="Point at the part of your artwork that must never be cropped out. Drag on the image, or use the arrow keys."
    >
      <div className={styles.framingRow}>
        <FocalPicker
          src={cover}
          focal={current.cover?.focal}
          label="Focal point for the cover artwork"
          onChange={(focal) => setFocal("cover", focal)}
        />
        <div className={styles.framingSide}>
          <CropPreviews src={cover} presentation={current} target="cover" />
          {current.cover?.focal && <button type="button" className={styles.ghostButton} onClick={() => clearFocal("cover")}>
            <RotateCcw size={15} aria-hidden />Reset framing
          </button>}
        </div>
      </div>
    </Field>}

    <Field
      label="Desktop banner"
      optional
      hint="A wide image for the top of the page on large screens. Without one, your cover artwork is used and framed by the focal point above."
    >
      <div className={styles.coverRow}>
        <div className={styles.bannerPreview}>
          {banner
            ? <img src={banner} alt="" style={artStyle(current, "banner", "16:9")} />
            : cover
              ? <img src={cover} alt="" style={artStyle(current, "cover", "16:9")} />
              : <ImagePlus size={22} aria-hidden />}
        </div>
        <div className={styles.coverActions}>
          <label className={styles.fileButton}>
            <Upload size={15} aria-hidden />{busy ? "Uploading…" : banner ? "Replace banner" : "Upload banner"}
            <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={busy} onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) await uploadBanner(file);
            }} />
          </label>
          {(bannerPath || bannerUrl) && <button type="button" className={styles.ghostButton} onClick={() => {
            onChange({ bannerPath: "", bannerUrl: "" });
            clearFocal("banner");
          }}>Remove banner</button>}
          {!banner && cover && <small className={styles.framingNote}>
            Showing your cover artwork as it will appear on a wide screen.
          </small>}
        </div>
      </div>
      {banner && <div className={styles.framingRow}>
        <FocalPicker
          src={banner}
          focal={current.banner?.focal}
          label="Focal point for the desktop banner"
          onChange={(focal) => setFocal("banner", focal)}
        />
        <div className={styles.framingSide}>
          <CropPreviews src={banner} presentation={current} target="banner" />
        </div>
      </div>}
    </Field>
  </>;
}
