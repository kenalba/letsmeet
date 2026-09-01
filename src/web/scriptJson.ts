/**
 * JSON safe to drop inside a <script> element. Escaping every `<` is the only sound rule:
 * escaping just `</` still lets `<!--<script>` flip the tokenizer into script-data-escaped
 * state and swallow the rest of the document as script text.
 */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}
