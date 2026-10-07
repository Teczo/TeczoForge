// An error with an HTTP status code and a message that is safe to show the user.
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
