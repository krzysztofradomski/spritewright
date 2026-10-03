export function composeGenerationBrief(
  protectedBrief: string,
  productionNotes: string,
) {
  const locked = protectedBrief.trim();
  const notes = productionNotes.trim();
  if (!locked) return notes;
  return notes ? `${locked}\n\nAdditional production notes:\n${notes}` : locked;
}
