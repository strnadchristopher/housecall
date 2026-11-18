/** An explicit build capability, never inferred from hostname or a URL parameter. */
export const hosted = import.meta.env?.MODE === 'hosted';
