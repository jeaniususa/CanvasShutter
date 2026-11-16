/**
 * The actions the built-in assistant may take, described for an AI model, and the code that runs
 * one of them through the editor's command layer. The list mirrors the Claude Code bridge
 * (editor-mcp/src/server.ts) so both ways of connecting behave the same.
 */
type Schema = Record<string, unknown>;

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Schema;
  /** Name of the command in commands.ts that carries it out. */
  command: string;
}

/** Anything with a run(method, params) function: the editor's commands, or a stand-in in tests. */
export interface CommandRunner { run(method: string, params?: Record<string, unknown>): Promise<unknown> }

export interface ToolCall { id: string; name: string; args: Record<string, unknown>; /** Set when the model's arguments could not be read. */ badArgs?: string }

export interface ToolOutcome {
  id: string;
  /** What the model is told. */
  text: string;
  /** A picture for the model to look at (the photo preview). */
  image?: { base64: string; mediaType: string };
  isError: boolean;
  /** One short line for the person, shown in the chat. */
  summary: string;
}

const num = (description: string): Schema => ({ type: 'number', description });
const none: Schema = { type: 'object', properties: {}, additionalProperties: false };
const levelsFor: Schema = {
  type: 'object', additionalProperties: false,
  properties: {
    black: num('Input black point, 0 to 253. Raising it darkens the shadows.'),
    white: num('Input white point, 2 to 255. Lowering it brightens the highlights.'),
    gamma: num('Midtones, 0.10 to 9.99. Above 1 brightens, below 1 darkens. 1 is neutral.'),
  },
};
const change: Schema = {
  type: 'object', additionalProperties: false,
  description: 'Only include the controls you want to change.',
  properties: {
    exposure: num('Stops, -5 to +5. Overall brightness.'),
    contrast: num('-100 to +100.'),
    highlights: num('-100 to +100. Negative darkens the bright tones.'),
    shadows: num('-100 to +100. Positive brightens the dark tones.'),
    whites: num('-100 to +100. Moves the white end.'),
    blacks: num('-100 to +100. Moves the black end.'),
    temp: num('-100 (cooler, bluer) to +100 (warmer, yellower).'),
    tint: num('-100 (greener) to +100 (more magenta).'),
    vibrance: num('-100 to +100. Saturation that favours muted colours.'),
    saturation: num('-100 (grey) to +100.'),
    levels: {
      type: 'object', additionalProperties: false,
      description: 'Levels per channel: rgb (all channels) or r, g, b individually.',
      properties: { rgb: levelsFor, r: levelsFor, g: levelsFor, b: levelsFor },
    },
  },
};
const mode: Schema = {
  type: 'string', enum: ['set', 'adjust'],
  description: '"set" (the default): the numbers are the new values. "adjust": the numbers are added to the current values (a nudge).',
};

export const TOOLS: ToolDef[] = [
  { name: 'editor_status', command: 'status', parameters: none,
    description: 'Which photo is open, its current adjustments, how many photos are in the library, and the list of controls with their ranges. Call this first if you do not know what is open.' },
  { name: 'get_preview', command: 'get_preview',
    description: 'Returns a picture of the open photo as currently edited, so you can judge it and check your changes.',
    parameters: { type: 'object', additionalProperties: false, properties: { maxSide: { type: 'integer', minimum: 256, maximum: 1568, description: 'Longest side of the preview in pixels. Default 1024.' } } } },
  { name: 'get_histogram', command: 'get_histogram', parameters: none,
    description: 'Numbers describing the open photo as currently edited, per channel on a 0-255 scale: mean, percentiles, and the share of pixels at pure black and pure white (clipping).' },
  { name: 'set_adjustments', command: 'set_adjustments',
    description: 'Change sliders and/or levels on the open photo. Values outside a control\'s range are limited to the range and reported in "notes". Each call is one undo step.',
    parameters: { type: 'object', additionalProperties: false, required: ['change'], properties: { change, mode } } },
  { name: 'reset_adjustments', command: 'reset',
    description: 'Put the open photo\'s settings back to neutral: everything, or one section.',
    parameters: { type: 'object', additionalProperties: false, properties: { section: { type: 'string', enum: ['all', 'levels', 'light', 'color'], description: 'Default "all".' } } } },
  { name: 'undo', command: 'undo', parameters: none, description: 'Undo the last change on the open photo.' },
  { name: 'redo', command: 'redo', parameters: none, description: 'Redo the change that was just undone on the open photo.' },
  { name: 'list_photos', command: 'list_photos', parameters: none,
    description: 'The photos in the editor\'s library: id, file name, size, and whether each has adjustments.' },
  { name: 'open_photo', command: 'open_photo',
    description: 'Switch the editor to another photo in the library, by file name or id. The photo\'s own saved adjustments are loaded.',
    parameters: { type: 'object', additionalProperties: false, required: ['photo'], properties: { photo: { type: 'string', description: 'File name or id from list_photos.' } } } },
  { name: 'apply_adjustments_to_photos', command: 'apply_to_photos',
    description: 'Apply the same change to several photos, one after another, saving each. Use mode "adjust" to nudge each photo from its own current settings, or "set" to give them all the same values. Returns a per-photo result.',
    parameters: { type: 'object', additionalProperties: false, required: ['photos', 'change'], properties: {
      photos: { type: 'array', items: { type: 'string' }, description: 'File names or ids from list_photos. Use ["all"] for every photo in the library.' },
      change, mode,
    } } },
  { name: 'export_photo', command: 'export',
    description: 'Export the open photo at full size with its adjustments applied. The browser saves the file to the user\'s Downloads folder (the browser may ask the user to allow the download).',
    parameters: { type: 'object', additionalProperties: false, properties: { format: { type: 'string', enum: ['png', 'jpeg'], description: 'Default "jpeg".' } } } },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
const signed = (v: number) => (v > 0 ? `+${v}` : `${v}`);

/** One short line for the person about what was just done. */
function describe(name: string, args: Record<string, unknown>, result: Record<string, unknown>): string {
  switch (name) {
    case 'set_adjustments': {
      const changed = Object.entries((result.changed ?? {}) as Record<string, number>);
      if (!changed.length) return 'No change was needed';
      return `Set ${changed.map(([k, v]) => (k.startsWith('levels.') ? `${k.slice(7).replace('.', ' ')} ${v}` : `${k} ${signed(v)}`)).join(', ')}`;
    }
    case 'reset_adjustments': return args.section && args.section !== 'all' ? `Reset ${String(args.section)}` : 'Reset all adjustments';
    case 'undo': return 'Undid the last change';
    case 'redo': return 'Redid the change';
    case 'get_preview': return 'Looked at the photo';
    case 'get_histogram': return 'Checked the histogram';
    case 'editor_status': return 'Checked the editor';
    case 'list_photos': return 'Looked through the library';
    case 'open_photo': return `Opened ${(result.openPhoto as { name?: string } | null)?.name ?? 'the photo'}`;
    case 'apply_adjustments_to_photos': return `Updated ${String(result.updated)} of ${String(result.requested)} photos`;
    case 'export_photo': return `Exported ${String(result.fileName ?? 'the photo')} to Downloads`;
    default: return name;
  }
}

/** Runs one action the model asked for. Never throws: a failure becomes an outcome the model can read. */
export async function runTool(commands: CommandRunner, call: ToolCall): Promise<ToolOutcome> {
  const fail = (message: string): ToolOutcome => ({ id: call.id, text: message, isError: true, summary: message });
  const tool = BY_NAME.get(call.name);
  if (!tool) return fail(`There is no action called "${call.name}".`);
  if (call.badArgs) return fail(`The arguments for ${call.name} were not valid JSON: ${call.badArgs}`);
  try {
    let args = call.args;
    if (call.name === 'export_photo') args = { format: 'jpeg', ...args };
    // The schema asks for a list (the simplest shape for every AI model); the command also takes the word "all".
    if (call.name === 'apply_adjustments_to_photos' && Array.isArray(args.photos) && args.photos.length === 1 && args.photos[0] === 'all') args = { ...args, photos: 'all' };
    const result = (await commands.run(tool.command, args)) as Record<string, unknown>;
    const summary = describe(call.name, call.args, result);
    if (call.name === 'get_preview') {
      const { jpegBase64, ...rest } = result as { jpegBase64: string };
      return { id: call.id, text: JSON.stringify(rest), image: { base64: jpegBase64, mediaType: 'image/jpeg' }, isError: false, summary };
    }
    return { id: call.id, text: JSON.stringify(result), isError: false, summary };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
