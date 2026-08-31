# Lens: architecture

Does this sit in the right place, at the right level, with the right coupling?

Look for: logic placed in the wrong module or layer — a validation rule in a
handler, a database concern in a view, a policy decision made by the component
furthest from the data it needs; a boundary crossed directly where an existing
interface already crosses it; a new abstraction built for its one caller,
adding indirection nothing yet needs; a business rule or invariant duplicated
because the common policy has no owner; a dependency pointing the wrong way,
so the general depends on the specific.

Point at where it belongs, not just where it does not. "This is in the wrong
place" is not a finding; "`validateDiscount` reads the cart's tax rules
directly from the pricing module — every other checkout rule goes through
`PricingPolicy`, and this is the only one that reaches around it" is.

Not yours: local naming, formatting, helper choice, and idiom — consistency
reads those; whether the logic is correct; how fast it runs.
