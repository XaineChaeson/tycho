// What the console asks to define a line: an account of an executor whose login is a line to
// a model service and that line's key (docs/design/native-login.md). An adapter declares the
// form and reads what it gathered; the console draws it and knows no executor's fields by
// name. Pure data, so what the service tells the console is the declaration itself.

export type ProviderField =
  | { name: string; kind: 'text'; label: string; placeholder?: string; hint?: string }
  | { name: string; kind: 'choice'; label: string; options: readonly { value: string; label: string }[]; hint?: string }
  // The models the line serves, one row each: the name a tier calls it by, and the strengths
  // it takes out of `efforts` (none ticked: it takes no strength at all). `image`, when the
  // executor has to be told which models take pictures, is what that switch is called.
  | { name: string; kind: 'models'; label: string; efforts: readonly string[]; image?: string; hint?: string }
  // The executor's own settings beside the ones asked above, as its own text, kept as written.
  | { name: string; kind: 'more'; label: string; hint?: string };

export interface ProviderLine {
  id: string;
  // The name a tier calls a line of this kind by, which the form writes into each tier itself.
  route: string;
  label: string;
  hint?: string;
  fields: readonly ProviderField[];
}

export interface ProviderForm {
  // The kinds of line an account may be, in the order they are offered; the first is the default.
  lines: readonly ProviderLine[];
  // What the line's secret is called, and where the owner gets one.
  key: { label: string; hint?: string };
}

// One model as the `models` field gathers it.
export interface ProviderModelRow {
  id: string;
  efforts?: string[];
  image?: boolean;
}

// What the form gathered: the line picked and that line's fields by name. The key is not part
// of it — it travels beside it and is kept apart.
export interface ProviderDraft {
  line: string;
  [field: string]: unknown;
}
