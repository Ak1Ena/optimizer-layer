- R1: parseCount accepts nonnegative safe integer numbers and decimal digit strings.
Acceptance R1: parseCount preserves valid numeric values, including zero and Number.MAX_SAFE_INTEGER.
- R2: parseCount handles invalid values according to the confirmed user decision.
Acceptance R2: Invalid parseCount outcomes agree with the imported user decision, including negatives, fractions, empty text, whitespace, signs, exponent notation, and unsafe integers.
- R3: parseCount rejects unsupported input types without coercion.
Acceptance R3: null, undefined, booleans, objects, and arrays follow the same invalid-value policy.
Question human Q1: What is the required policy for invalid count values?
Question local Q2: Which project module implements parseCount?
