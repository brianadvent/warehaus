# ADR-0001: Revenue excludes cancelled invoices

**Status**: Accepted

**Context**: Cancelled invoices stay in the billing system. Counting them
overstates revenue and outstanding amounts.

**Decision**: Every revenue figure excludes invoices that carry a
`cancel_id`. Tools that aggregate revenue apply this filter before summing.
