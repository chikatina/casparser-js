/** The exception hierarchy the parsers raise. Names match the Python original. */

export class ParserException extends Error {
  constructor(message) {
    super(message);
    this.name = this.constructor.name;
  }
}

/** Something went wrong reading a statement header. */
export class HeaderParseError extends ParserException {}

/** Something went wrong reading the PDF. */
export class CASParseError extends ParserException {}

/** The PDF password was rejected. */
export class IncorrectPasswordError extends CASParseError {}

/** Transactions did not add up. */
export class CASIntegrityError extends ParserException {}

/** The statement does not cover enough history to compute gains. */
export class IncompleteCASError extends ParserException {}

/** A capital-gains computation could not be completed. */
export class GainsError extends ParserException {}
