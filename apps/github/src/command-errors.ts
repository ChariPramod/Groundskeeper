/** Messages created by our CLI validation, never external stderr or API response bodies. */
export class CommandInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandInputError";
  }
}
