/** Input for the reverse_string tool. */
export interface ReverseStringInput {
  text: string;
}

/** Result from the reverse_string tool. */
export interface ReverseStringResult {
  original: string;
  reversed: string;
  length: number;
}

/** Input for the word_count tool. */
export interface WordCountInput {
  text: string;
  /** Count unique words only. Defaults to false. */
  unique?: boolean;
}

/** Result from the word_count tool. */
export interface WordCountResult {
  text: string;
  wordCount: number;
  characterCount: number;
  uniqueWords?: number;
}
