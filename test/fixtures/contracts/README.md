# Deterministic onboarding contract fixtures

`source/Fixtures.sol` is the reviewable source for the ABI and creation bytecode constants in `identityRegistry.ts` and `tawgProfile.ts`. It is test infrastructure, not a production ERC-8004 Registry or TAWG Profile implementation.

The committed constants were produced on macOS with:

```text
solc, the solidity compiler commandline interface
Version: 0.8.30+commit.73712a01.Darwin.appleclang
```

from the `source/` directory, with optimizer disabled and the compiler's default metadata settings:

```bash
solc --combined-json abi,bin Fixtures.sol
```

Review identifiers:

- `Fixtures.sol` SHA-256: `18b95a06f6dded479764bfc080d39319e23449e11088e558f0fc4850692f14fc`
- compiler executable SHA-256: `6e67873ae89d0944ba55651491e9ce70f1c6a271dbfdd8d52e088089b44258bc`

Tests consume only the committed TypeScript constants. They do not invoke a compiler, and npm package conformance requires this source and README to remain excluded from the package.
