# Decisions

- 2025-11-04: Amounts are stored and computed as integer cents.
- 2026-03-02: Printed line amounts are what the customer agreed to and what accounting books. Never change how a line amount is computed (each line is rounded to the nearest cent, halves up). The invoice total is defined as the sum of the printed line amounts.
