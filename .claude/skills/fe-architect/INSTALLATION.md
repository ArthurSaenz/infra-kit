# Frontend Architect Skill - Installation Guide

Complete guide for installing and using the Frontend Architect Claude Code Skill across multiple repositories.

---

## Table of Contents

1. [Quick Install](#quick-install)
2. [Installation Methods](#installation-methods)
3. [Verification](#verification)
4. [Troubleshooting](#troubleshooting)
5. [Next Steps](#next-steps)

---

## Quick Install

### For Personal Use (Fastest)

```bash
# Navigate to your target repository
cd /path/to/your/project

# Create .claude/skills directory if it doesn't exist
mkdir -p .claude/skills

# Copy the skill
cp -r /path/to/sandbox-workspace/.claude/skills/fe-architect .claude/skills/

# Done! The skill is now available in Claude Code
```

### For Team Distribution (ZIP File)

```bash
# Navigate to your target repository
cd /path/to/your/project

# Create .claude/skills directory
mkdir -p .claude/skills

# Unzip the skill
unzip fe-architect.zip -d .claude/skills/

# Commit to version control
git add .claude/skills/fe-architect/
git commit -m "Add fe-architect Claude Code skill v1.2.0"
git push
```

---

## Installation Methods

### Method 1: Direct Copy (Recommended for Most Users)

**Best for:** Personal projects, small teams, quick setup

**Steps:**

1. Navigate to your target repository:
   ```bash
   cd /path/to/your/project
   ```

2. Create the skills directory:
   ```bash
   mkdir -p .claude/skills
   ```

3. Copy the skill folder:
   ```bash
   cp -r /Users/arthur/projects/sandbox-workspace/.claude/skills/fe-architect .claude/skills/
   ```

4. Verify installation:
   ```bash
   ls .claude/skills/fe-architect/SKILL.md
   ```

5. Commit to version control (recommended):
   ```bash
   git add .claude/skills/
   git commit -m "Add fe-architect Claude Code skill v1.2.0"
   git push
   ```

**Pros:**
- ✅ Simple and straightforward
- ✅ Works offline
- ✅ No dependencies
- ✅ Each repo has independent copy

**Cons:**
- ❌ Manual updates needed per repo
- ❌ Skill changes don't propagate automatically

---

### Method 2: Packaged ZIP Distribution (Best for Teams)

**Best for:** Team distribution, standardized installs, releases

**Package Location:** `fe-architect.zip`

**Steps:**

**For Skill Maintainers (Package Creation):**

```bash
# Already done, but to recreate:
cd /Users/arthur/projects/sandbox-workspace
python3 .claude/skills/skill-creator/scripts/package_skill.py .claude/skills/fe-architect

# Creates: fe-architect.zip
```

**For Team Members (Installation):**

1. Download the ZIP file from your team's shared location

2. Navigate to your project:
   ```bash
   cd /path/to/your/project
   ```

3. Create skills directory:
   ```bash
   mkdir -p .claude/skills
   ```

4. Extract the skill:
   ```bash
   unzip fe-architect.zip -d .claude/skills/
   ```

5. Verify:
   ```bash
   ls .claude/skills/fe-architect/SKILL.md
   ```

6. Commit:
   ```bash
   git add .claude/skills/fe-architect/
   git commit -m "Add fe-architect skill v1.2.0"
   git push
   ```

**Distribution Channels:**

- **Slack/Teams:** Attach ZIP file with installation instructions
- **Confluence/Wiki:** Upload to documentation page
- **GitHub Releases:** Create release with packaged skill
- **Shared Drive:** Place in team shared folder
- **Internal npm registry:** Publish as package (advanced)

**Pros:**
- ✅ Easy distribution
- ✅ Version control friendly
- ✅ Consistent across team
- ✅ Easy to update (send new ZIP)

**Cons:**
- ❌ Manual updates needed
- ❌ Each repo stores full copy

---

## Verification

### After Installation

**1. Check file structure:**

```bash
ls .claude/skills/fe-architect/SKILL.md
ls .claude/skills/fe-architect/references/
ls .claude/skills/fe-architect/scripts/
ls .claude/skills/fe-architect/assets/feature-template/
```

**2. Validate skill (if skill-creator available):**

```bash
python3 .claude/skills/skill-creator/scripts/quick_validate.py .claude/skills/fe-architect
```

**3. Test in Claude Code:**

Open Claude Code in your project and try:

```
"Create a new feature for user-profile"
```

You should see the skill activate with interactive questions.

**4. Check skill is recognized:**

In Claude Code, type `/` and look for the skill in available commands (if your Claude Code version supports skill listing).

### Expected Files

```
.claude/skills/fe-architect/
├── SKILL.md
├── INSTALLATION.md
├── references/ (15 files)
│   ├── core/
│   │   ├── architecture.md
│   │   ├── cross-feature.md
│   │   ├── enforcement-rules.md
│   │   └── naming-conventions.md
│   ├── getting-started/
│   │   ├── decision-trees.md
│   │   ├── quick-reference.md
│   │   └── quick-start.md
│   ├── implementation/
│   │   ├── api-layer.md
│   │   ├── error-handling.md
│   │   ├── state-management.md
│   │   ├── styling.md
│   │   └── templates.md
│   ├── maintenance/
│   │   ├── analytics.md
│   │   ├── migration.md
│   │   └── troubleshooting.md
│   ├── patterns/
│   │   ├── cookbook-advanced.md
│   │   ├── cookbook-async.md
│   │   ├── cookbook-crud.md
│   │   ├── cookbook-forms.md
│   │   └── cookbook-lists.md
│   └── testing/
│       ├── storybook.md
│       └── testing.md
├── scripts/ (4 files)
│   ├── package.json
│   ├── validate_feature.mjs
│   ├── analyze_imports.mjs
│   └── check_structure.mjs
└── assets/feature-template/ (13 files)
    ├── README.md
    ├── index.ts
    ├── types.ts
    ├── services.ts
    ├── services/
    │   ├── main.ts
    │   ├── api.ts
    │   └── libs.ts
    ├── components/
    │   ├── [FEATURE_NAME_KEBAB]-component.tsx
    │   ├── __tests__/[FEATURE_NAME_KEBAB]-component.test.tsx
    │   └── __stories__/[FEATURE_NAME_KEBAB]-component.stories.tsx
    └── containers/
        ├── [FEATURE_NAME_KEBAB]-container.tsx
        └── __tests__/[FEATURE_NAME_KEBAB]-container.test.tsx
```

---

## Troubleshooting

### Skill Not Activating

**Problem:** Claude Code doesn't recognize the skill

**Solutions:**

1. **Check directory structure:**
   ```bash
   # Must be exactly:
   .claude/skills/fe-architect/SKILL.md

   # NOT:
   .claude/skills/fe-architect/fe-architect/SKILL.md
   ```

2. **Restart Claude Code:**
   - Close and reopen Claude Code
   - Skills are loaded at startup

3. **Verify SKILL.md:**
   ```bash
   head -n 10 .claude/skills/fe-architect/SKILL.md
   # Should see YAML frontmatter with name: fe-architect
   ```

4. **Check permissions:**
   ```bash
   chmod -R 755 .claude/skills/fe-architect/
   ```

### Files Not Found

**Problem:** Skill references missing files

**Solution:**

```bash
# Re-extract from ZIP
rm -rf .claude/skills/fe-architect
unzip fe-architect.zip -d .claude/skills/

# Or re-copy
rm -rf .claude/skills/fe-architect
cp -r /path/to/source/.claude/skills/fe-architect .claude/skills/
```

### Validation Scripts Not Working

**Problem:** Node.js scripts fail to execute

**Solution:**

```bash
# Make scripts executable
chmod +x .claude/skills/fe-architect/scripts/*.mjs

# Ensure Node.js is available (requires Node 14+)
node --version

# No dependencies needed - uses Node.js built-in modules only
```

### Skill Conflicts

**Problem:** Multiple versions of skill installed

**Solution:**

```bash
# Remove all versions
rm -rf .claude/skills/fe-architect*

# Install fresh copy
unzip fe-architect.zip -d .claude/skills/
```

---

## Next Steps

After installation:

1. **Read the Quick Start:**
   ```bash
   cat .claude/skills/fe-architect/references/quick-start.md
   ```

2. **Complete First Feature Tutorial:**
   Follow the "Your First Feature" walkthrough in quick-start.md

3. **Bookmark References:**
   - Architecture patterns
   - Naming conventions
   - State management
   - Testing standards

4. **Set Up Validation Scripts:**
   ```bash
   # Test validation
   node .claude/skills/fe-architect/scripts/validate_feature.mjs features/your-feature
   ```

5. **Share with Team:**
   - Add to team wiki
   - Present in team meeting
   - Create Slack channel for questions

---

## Support

### Resources

- **Skill Documentation:** `.claude/skills/fe-architect/references/`
- **Feature Template:** `.claude/skills/fe-architect/assets/feature-template/`
- **Quick Start:** `.claude/skills/fe-architect/references/getting-started/quick-start.md`

### Getting Help

1. Check `troubleshooting.md` for common issues
2. Review decision trees for architectural questions
3. Consult cookbook.md for pattern examples
4. Ask in team's frontend channel

### Reporting Issues

If you find bugs or have suggestions:

1. Document the issue with examples
2. Include skill version (from SKILL.md)
3. Provide steps to reproduce
4. Share with skill maintainer

---

## License

MIT - See LICENSE file in skill directory

---

**Skill Version:** 1.2.0
**Last Updated:** 2025-01-14
**Maintainer:** Feature Architecture Team
