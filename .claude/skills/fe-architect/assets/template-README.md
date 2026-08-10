# Feature Template

Scaffold template for creating new features following the fe-architect skill guidelines.

This file lives **outside** `feature-template/` on purpose: everything inside that directory is
copied verbatim into a new feature, and a stray `README.md` there would end up in every feature.

## Use the scaffolder

```bash
node .claude/skills/fe-architect/scripts/scaffold_feature.mjs [features-dir] [feature-name]
node .claude/skills/fe-architect/scripts/scaffold_feature.mjs apps/client/src/features user-profile
node .claude/skills/fe-architect/scripts/scaffold_feature.mjs apps/client/src/features user-profile --complex
```

The scaffolder copies the template, substitutes every placeholder in file contents **and** file
names, layers in exactly one services variant, then runs `validate_feature.mjs` and
`check_structure.mjs`. It **exits non-zero** if the result does not validate.

Doing this by hand means four placeholder substitutions across eleven files plus five renames —
which is why it is a script.

## Template layout

```
assets/
├── template-README.md          # this file (not copied into features)
└── feature-template/
    ├── index.ts                # Public API exports
    ├── types.ts                # TypeScript definitions
    ├── __tests__/              # All tests (components + containers)
    │   ├── feature-name-component.test.tsx
    │   └── feature-name-container.test.tsx
    ├── __stories__/            # Storybook stories (dumb components only)
    │   └── feature-name-component.stories.tsx
    ├── components/             # Dumb components (UI only)
    │   └── feature-name-component.tsx
    ├── containers/             # Smart components (logic + UI)
    │   └── feature-name-container.tsx
    └── _variants/              # Exactly one of these is layered in; never copied as-is
        ├── simple/
        │   └── services.ts     # < 3 endpoints AND < 250 lines
        └── complex/
            └── services/       # 3+ endpoints OR > 250 lines
                ├── main.ts     # Atoms & orchestration
                ├── api.ts      # HTTP requests
                └── libs.ts     # Pure business logic
```

A finished feature ships **either** `services.ts` **or** `services/` — never both, and never
`_variants/`. Both validators report the conflict if it happens.

## Placeholders

| Placeholder | Meaning | `user-profile` becomes |
|---|---|---|
| `Feature Name` | Human-readable name | `User Profile` |
| `FeatureName` | PascalCase | `UserProfile` |
| `featureName` | camelCase | `userProfile` |
| `feature-name` | kebab-case (also used in file names) | `user-profile` |

Substitution is longest-first, so `Feature Name` is consumed before the shorter forms can match
inside it. `feature-name` is rejected as a feature name because it collides with the placeholder.

## Manual fallback

If you must copy by hand, remember to delete `_variants/` after promoting one variant to the
feature root:

```bash
cp -r .claude/skills/fe-architect/assets/feature-template [features-dir]/[feature-name]
# then: substitute placeholders, rename files, promote one variant, delete _variants/
```

## Validation

```bash
node .claude/skills/fe-architect/scripts/validate_feature.mjs [features-dir]/[feature-name]
node .claude/skills/fe-architect/scripts/analyze_imports.mjs [features-dir]
node .claude/skills/fe-architect/scripts/check_structure.mjs [features-dir]/[feature-name]
```

Non-zero exit means STOP and fix. Errors are blocking; warnings are advisory.

## Additional resources

See the skill's `SKILL.md` for the CREATE, MODIFY, and REFACTOR workflows.
