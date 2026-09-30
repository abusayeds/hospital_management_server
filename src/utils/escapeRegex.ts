// Escape user input before using it inside a MongoDB $regex
export const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
