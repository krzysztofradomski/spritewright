import { expect, test } from "vitest";
import { composeGenerationBrief } from "./brief-composer.js";

test("keeps a protected remix brief separate from optional production notes", () => {
  expect(
    composeGenerationBrief("Locked remix instruction.", "Add a red scarf."),
  ).toBe(
    "Locked remix instruction.\n\nAdditional production notes:\nAdd a red scarf.",
  );
  expect(composeGenerationBrief("Locked remix instruction.", "")).toBe(
    "Locked remix instruction.",
  );
});
