# Feature Template

This directory contains scaffold templates for creating new features following the fe-architect skill guidelines.

## How to Use

When creating a new feature, copy this template and replace all placeholders:

### Placeholders to Replace

- `Feature Name` → Human-readable name (e.g., "User Profile")
- `feature-name` → kebab-case name (e.g., "user-profile")
- `featureName` → camelCase name (e.g., "userProfile")
- `FeatureName` → PascalCase name (e.g., "UserProfile")

### Example Replacement

For a "User Profile" feature:
```bash
Feature: User Profile
Kebab:   user-profile
Camel:   userProfile
Pascal:  UserProfile
```

### File Structure Included

```
feature-template/
├── index.ts                    # Public API exports
├── types.ts                    # TypeScript definitions
├── services.ts                 # Single file services (< 3 endpoints)
├── services/                   # Folder services (3+ endpoints)
│   ├── main.ts                # Atoms & orchestration
│   ├── api.ts                 # HTTP requests
│   └── libs.ts                # Pure business logic
├── __tests__/                  # All tests (components + containers)
│   ├── [name]-component.test.tsx
│   └── [name]-container.test.tsx
├── __stories__/                # Storybook stories (dumb components only)
│   └── [name]-component.stories.tsx
├── components/                 # Dumb components (UI only)
│   └── [name]-component.tsx
└── containers/                 # Smart components (logic + UI)
    └── [name]-container.tsx
```

## Quick Start

1. Copy this template directory to `features/[your-feature-name]/`
2. Replace all `FeatureName`, `featureName`, `feature-name`, and `Feature Name` placeholders
3. Rename files from `feature-name-*` to your actual feature name
4. Choose either `services.ts` (simple) OR `services/` folder (complex)
5. Delete unused files
6. Implement your feature logic
7. Run validation: `node .claude/skills/fe-architect/scripts/validate_feature.mjs features/[your-feature-name]`

## When to Use services.ts vs services/ Folder

**Use `services.ts` (single file) when:**
- < 3 API endpoints
- < 250 lines total
- Simple business logic

**Use `services/` (folder) when:**
- 3+ API endpoints
- > 250 lines total
- Complex business logic requiring separation

If using `services/` folder, delete `services.ts`.
If using `services.ts`, delete `services/` folder.

## Validation

After creating your feature, validate it:

```bash
# Complete feature validation
node .claude/skills/fe-architect/scripts/validate_feature.mjs features/[feature-name]

# Check cross-feature imports
node .claude/skills/fe-architect/scripts/analyze_imports.mjs features/[feature-name]

# Verify structure
node .claude/skills/fe-architect/scripts/check_structure.mjs features/[feature-name]
```

## Additional Resources

See the skill's SKILL.md for complete workflows:
- CREATE WORKFLOW (new features)
- MODIFY WORKFLOW (existing features)
- REFACTOR WORKFLOW (legacy code)
