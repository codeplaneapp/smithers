/** A single recognized phrase: results[i][0].transcript holds the best guess. */
export type SpeechRecognitionResultEvent = {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
};

/**
 * The slice of the Web Speech API's SpeechRecognition we use. The DOM lib does
 * not ship these types in every target, so we model just what dictation needs.
 */
export type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((event: SpeechRecognitionResultEvent) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
};
