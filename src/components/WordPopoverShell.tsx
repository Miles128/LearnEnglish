import type { SpeakTarget } from "../useTts";
import { normalizeKey } from "../wordLevels";
import { isPhraseSelection } from "../wordResolve";
import SelectionPopover, { type Popover } from "./SelectionPopover";

export type WordPopoverShellProps = {
  popover: Popover;
  speaking: boolean;
  speakTarget: SpeakTarget | null;
  knownTerms: string[];
  onSpeakWord: (text: string) => void;
  onAddVocab: () => void;
  onAddPhrase: () => void;
  onToggleKnown: (term: string) => void;
  onClose: () => void;
};

/**
 * Home + Reader share one popover wiring: multi-word selections offer
 * "add to phrase library", single words offer "mark as known".
 */
export default function WordPopoverShell({
  popover,
  knownTerms,
  onAddPhrase,
  onToggleKnown,
  ...rest
}: WordPopoverShellProps) {
  const isPhrase =
    popover.source != null && isPhraseSelection(popover.source);
  return (
    <SelectionPopover
      {...rest}
      popover={popover}
      onAddPhrase={isPhrase ? onAddPhrase : undefined}
      onToggleKnown={
        isPhrase ? undefined : () => onToggleKnown(popover.text)
      }
      known={knownTerms.includes(normalizeKey(popover.text))}
    />
  );
}
