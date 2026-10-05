import { z } from "zod";

export const qualitySchema = z.enum(["0", "1", "2"]);
export type Quality = z.infer<typeof qualitySchema>;
export const qualityLabels: Record<Quality, string> = {
  "0": "Main",
  "1": "Sub 1",
  "2": "Sub 2",
};
export const cameraSchema = z.object({
  id: z.string().regex(/^cam-[1-6]$/),
  name: z.string().trim().min(1).max(48),
  channel: z.number().int().min(1).max(64),
  enabled: z.boolean().optional(),
});
export type Camera = z.infer<typeof cameraSchema>;
// This household's channels 1–2 provide Sub 2; channels 3–6 provide Sub 1.
export function fallbackQuality(camera: Camera): Quality {
  return camera.channel <= 2 ? "2" : "1";
}
export function audioFallbackQuality(
  camera: Camera,
  quality: Quality,
): Quality | undefined {
  return camera.channel <= 2 && quality === "2" ? "1" : undefined;
}
export const camerasSchema = z
  .array(cameraSchema)
  .min(1)
  .max(6)
  .refine(
    (list) => new Set(list.map((c) => c.id)).size === list.length,
    "Camera IDs must be unique",
  );
export const preferencesSchema = z
  .object({
    version: z.literal(1),
    slots: z
      .array(z.string().regex(/^cam-[1-6]$/))
      .max(6)
      .refine((ids) => new Set(ids).size === ids.length),
    columns: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    cameras: z.record(
      z.string().regex(/^cam-[1-6]$/),
      z.object({
        quality: qualitySchema,
        muted: z.boolean(),
        stopped: z.boolean(),
      }),
    ),
  })
  .strict();
export type Preferences = z.infer<typeof preferencesSchema>;
export const defaults = (cameras: Camera[]): Preferences => ({
  version: 1,
  slots: cameras.filter((c) => c.enabled !== false).map((c) => c.id),
  columns: 3,
  cameras: Object.fromEntries(
    cameras.map((c) => [c.id, { quality: "1", muted: true, stopped: false }]),
  ),
});
export function normalizePreferences(
  value: unknown,
  cameras: Camera[],
): Preferences {
  const base = defaults(cameras);
  const result = preferencesSchema.safeParse(value);
  if (!result.success) return base;
  const available = new Set(
    cameras.filter((c) => c.enabled !== false).map((c) => c.id),
  );
  return {
    ...result.data,
    slots: result.data.slots.filter((id) => available.has(id)),
    cameras: Object.fromEntries(
      cameras.map((c) => [
        c.id,
        result.data.cameras[c.id] ?? base.cameras[c.id],
      ]),
    ),
  };
}
export function swapSlots(slots: string[], from: string, to: string): string[] {
  const a = slots.indexOf(from),
    b = slots.indexOf(to);
  if (a < 0 || b < 0 || a === b) return slots;
  const copy = [...slots];
  [copy[a], copy[b]] = [copy[b], copy[a]];
  return copy;
}

export const setupViewSchema = z.object({
  revision: z.number().int().nonnegative(),
  nvr: z.object({
    host: z.string().min(1).max(255),
    port: z.number().int().min(1).max(65535),
    credentialsSaved: z.boolean(),
  }),
  cameras: camerasSchema,
});
export type SetupView = z.infer<typeof setupViewSchema>;
export const setupUpdateSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    nvr: z
      .object({
        host: z.string().trim().min(1).max(255),
        port: z.number().int().min(1).max(65535),
        username: z.string().max(256),
        password: z.string().max(256),
      })
      .strict(),
    cameras: camerasSchema.refine(
      (list) => new Set(list.map((c) => c.channel)).size === list.length,
      "Channel numbers must be unique",
    ),
    householdPassword: z.string().min(1).max(128),
  })
  .strict();
export type SetupUpdate = z.infer<typeof setupUpdateSchema>;
