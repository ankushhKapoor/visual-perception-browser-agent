/**
 * Privacy Sanitizer Test Suite
 * 
 * Tests for DOM/text sanitization with proper placeholder replacement.
 * Can be run in browser console or Node.js with modifications.
 * 
 * Usage in browser:
 * 1. Load this file as a script in privacy-test.html
 * 2. Open browser DevTools console
 * 3. Call runPrivacySanitizerTests() to execute all tests
 */

/**
 * Mock sanitizer functions for testing (if running standalone)
 * In actual usage, these are imported from privacy-sanitizer.js
 */

// Test Case 1: Basic text sanitization with placeholders
function testBasicSanitization() {
  const testCases = [
    {
      name: "Email sanitization",
      input: "My email is rakshita@example.com and my phone is 9876543210",
      detections: [
        {
          piiType: "EMAIL",
          value: "rakshita@example.com",
          startIndex: 12,
          endIndex: 32,
          severity: "HIGH",
          confidence: 0.95
        },
        {
          piiType: "PHONE",
          value: "9876543210",
          startIndex: 49,
          endIndex: 59,
          severity: "HIGH",
          confidence: 0.90
        }
      ],
      expectedPatterns: ["<EMAIL_1>", "<PHONE_1>"],
      expectedOmits: ["rakshita@example.com", "9876543210"]
    },
    {
      name: "Multiple PIIs of same type",
      input: "Contact john@test.com or jane@test.com",
      detections: [
        {
          piiType: "EMAIL",
          value: "john@test.com",
          startIndex: 8,
          endIndex: 21,
          severity: "HIGH",
          confidence: 0.96
        },
        {
          piiType: "EMAIL",
          value: "jane@test.com",
          startIndex: 25,
          endIndex: 38,
          severity: "HIGH",
          confidence: 0.96
        }
      ],
      expectedPatterns: ["<EMAIL_1>", "<EMAIL_2>"],
      expectedOmits: ["john@test.com", "jane@test.com"]
    },
    {
      name: "Critical secret (password) - should be hidden",
      input: "Password is MySecure123!Pass",
      detections: [
        {
          piiType: "PASSWORD",
          value: "MySecure123!Pass",
          startIndex: 12,
          endIndex: 28,
          severity: "CRITICAL",
          confidence: 0.98
        }
      ],
      expectedPattern: "<SECRET>",
      shouldNotContain: "MySecure123!Pass"
    },
    {
      name: "Mixed PII types",
      input: "Email: test@example.com, Phone: 9876543210, Card: 1234-5678-9012-3456",
      detections: [
        {
          piiType: "EMAIL",
          value: "test@example.com",
          startIndex: 7,
          endIndex: 23,
          severity: "HIGH",
          confidence: 0.95
        },
        {
          piiType: "PHONE",
          value: "9876543210",
          startIndex: 32,
          endIndex: 42,
          severity: "HIGH",
          confidence: 0.90
        },
        {
          piiType: "CREDIT_CARD",
          value: "1234-5678-9012-3456",
          startIndex: 50,
          endIndex: 69,
          severity: "CRITICAL",
          confidence: 0.92
        }
      ],
      expectedPatterns: ["<EMAIL_1>", "<PHONE_1>", "<SECRET>"],
      shouldNotContains: ["test@example.com", "9876543210", "1234-5678-9012-3456"]
    }
  ];

  console.group("Test: Basic Sanitization");

  const results = testCases.map((testCase) => {
    const { sanitized, mapping } = mockSanitizeText(testCase.input, testCase.detections);

    let passed = true;
    const issues = [];

    // Check for expected patterns
    if (testCase.expectedPattern) {
      if (!sanitized.includes(testCase.expectedPattern)) {
        passed = false;
        issues.push(`Missing expected pattern: ${testCase.expectedPattern}`);
      }
    }

    if (testCase.expectedPatterns) {
      testCase.expectedPatterns.forEach((pattern) => {
        if (!sanitized.includes(pattern)) {
          passed = false;
          issues.push(`Missing expected pattern: ${pattern}`);
        }
      });
    }

    // Check for omitted values
    if (testCase.expectedOmit) {
      if (sanitized.includes(testCase.expectedOmit)) {
        passed = false;
        issues.push(`Original value should be omitted: ${testCase.expectedOmit}`);
      }
    }

    if (testCase.expectedOmits) {
      testCase.expectedOmits.forEach((value) => {
        if (sanitized.includes(value)) {
          passed = false;
          issues.push(`Original value should be omitted: ${value}`);
        }
      });
    }

    // Check for critical secrets
    if (testCase.shouldNotContain) {
      if (sanitized.includes(testCase.shouldNotContain)) {
        passed = false;
        issues.push(`Critical secret should not be exposed: ${testCase.shouldNotContain}`);
      }
    }

    if (testCase.shouldNotContains) {
      testCase.shouldNotContains.forEach((value) => {
        if (sanitized.includes(value)) {
          passed = false;
          issues.push(`Critical secret should not be exposed: ${value}`);
        }
      });
    }

    return {
      testName: testCase.name,
      passed,
      issues,
      input: testCase.input,
      output: sanitized,
      sanitizationCount: testCase.detections.filter((d) => d.severity === "CRITICAL" || d.severity === "HIGH").length
    };
  });

  results.forEach((result) => {
    const icon = result.passed ? "✓" : "✗";
    console.log(`${icon} ${result.testName}`);
    if (!result.passed) {
      console.log("  Issues:", result.issues);
    }
    console.log("  Input:", result.input);
    console.log("  Output:", result.output);
  });

  console.groupEnd();

  return results;
}

// Test Case 2: Placeholder generation
function testPlaceholderGeneration() {
  console.group("Test: Placeholder Generation");

  const testCases = [
    { piiType: "EMAIL", index: 1, expected: "<EMAIL_1>" },
    { piiType: "PHONE", index: 1, expected: "<PHONE_1>" },
    { piiType: "PASSWORD", index: 1, expected: "<SECRET>" },
    { piiType: "API_KEY", index: 1, expected: "<SECRET>" },
    { piiType: "CREDIT_CARD", index: 1, expected: "<SECRET>" },
    { piiType: "CREDIT_CARD", index: 2, expected: "<SECRET>" },
    { piiType: "EMPLOYEE_ID", index: 1, expected: "<EMPLOYEE_ID_1>" }
  ];

  const results = testCases.map((testCase) => {
    const placeholder = mockGeneratePlaceholder(testCase.piiType, testCase.index);
    const passed = placeholder === testCase.expected;

    return {
      piiType: testCase.piiType,
      index: testCase.index,
      expected: testCase.expected,
      actual: placeholder,
      passed
    };
  });

  results.forEach((result) => {
    const icon = result.passed ? "✓" : "✗";
    console.log(
      `${icon} ${result.piiType}_${result.index}: "${result.actual}" ${
        result.passed ? "✓" : `✗ (expected: "${result.expected}")`
      }`
    );
  });

  console.groupEnd();

  return results;
}

// Test Case 3: Severity-based filtering
function testSeverityFiltering() {
  console.group("Test: Severity-based Filtering");

  const testCases = [
    {
      name: "CRITICAL severity - should sanitize",
      severity: "CRITICAL",
      confidence: 0.99,
      shouldSanitize: true
    },
    {
      name: "HIGH severity - should sanitize",
      severity: "HIGH",
      confidence: 0.90,
      shouldSanitize: true
    },
    {
      name: "CONTEXT_DEPENDENT with high confidence - should sanitize",
      severity: "CONTEXT_DEPENDENT",
      confidence: 0.80,
      shouldSanitize: true
    },
    {
      name: "CONTEXT_DEPENDENT with low confidence - should skip",
      severity: "CONTEXT_DEPENDENT",
      confidence: 0.60,
      shouldSanitize: false
    },
    {
      name: "LOW severity - should skip",
      severity: "LOW",
      confidence: 0.50,
      shouldSanitize: false
    }
  ];

  const results = testCases.map((testCase) => {
    const shouldSanitize = mockShouldSanitize({
      severity: testCase.severity,
      confidence: testCase.confidence
    });
    const passed = shouldSanitize === testCase.shouldSanitize;

    return {
      testName: testCase.name,
      severity: testCase.severity,
      confidence: testCase.confidence,
      expected: testCase.shouldSanitize,
      actual: shouldSanitize,
      passed
    };
  });

  results.forEach((result) => {
    const icon = result.passed ? "✓" : "✗";
    console.log(
      `${icon} ${result.testName}: ${result.actual} ${result.passed ? "✓" : "✗"}`
    );
  });

  console.groupEnd();

  return results;
}

// Test Case 4: Multiple occurrences with consistent numbering
function testConsistentNumbering() {
  console.group("Test: Consistent Placeholder Numbering");

  const input = "Email1: john@test.com, Email2: jane@test.com, Email3: admin@test.com";
  const detections = [
    {
      piiType: "EMAIL",
      value: "john@test.com",
      startIndex: 8,
      endIndex: 21,
      severity: "HIGH",
      confidence: 0.95
    },
    {
      piiType: "EMAIL",
      value: "jane@test.com",
      startIndex: 31,
      endIndex: 44,
      severity: "HIGH",
      confidence: 0.95
    },
    {
      piiType: "EMAIL",
      value: "admin@test.com",
      startIndex: 54,
      endIndex: 68,
      severity: "HIGH",
      confidence: 0.95
    }
  ];

  const { sanitized, mapping } = mockSanitizeText(input, detections);

  const hasEmail1 = sanitized.includes("<EMAIL_1>");
  const hasEmail2 = sanitized.includes("<EMAIL_2>");
  const hasEmail3 = sanitized.includes("<EMAIL_3>");
  const noOriginals =
    !sanitized.includes("john@test.com") &&
    !sanitized.includes("jane@test.com") &&
    !sanitized.includes("admin@test.com");

  const passed = hasEmail1 && hasEmail2 && hasEmail3 && noOriginals;

  console.log("Input:", input);
  console.log("Output:", sanitized);
  console.log(
    "✓ Consistent numbering:",
    `<EMAIL_1>, <EMAIL_2>, <EMAIL_3> ${passed ? "✓" : "✗"}`
  );

  console.groupEnd();

  return [
    {
      testName: "Consistent Numbering",
      passed,
      input,
      output: sanitized
    }
  ];
}

// Mock implementations for testing
function mockSanitizeText(text, detections) {
  const mapping = {};
  let sanitized = text;

  const ordered = [...detections]
    .filter((detection) => detection.startIndex !== undefined && detection.endIndex !== undefined)
    .sort((a, b) => (a.startIndex || 0) - (b.startIndex || 0));

  const piiCounts = {};
  const replacements = ordered.map((detection) => {
    const { piiType, value, startIndex, endIndex, severity, confidence } = detection;

    let placeholder;
    if (["PASSWORD", "OTP", "CVV", "API_KEY", "AUTH_TOKEN", "SESSION_SECRET", "CARD", "CREDIT_CARD", "ACCESS_TOKEN", "JWT"].includes(piiType)) {
      placeholder = "<SECRET>";
    } else {
      if (!piiCounts[piiType]) {
        piiCounts[piiType] = 1;
      }
      placeholder = `<${piiType}_${piiCounts[piiType]}>`;
      piiCounts[piiType]++;
    }

    return {
      piiType,
      startIndex,
      endIndex,
      placeholder,
      confidence: confidence || 0,
      severity,
      value
    };
  });

  replacements
    .sort((a, b) => (b.startIndex || 0) - (a.startIndex || 0))
    .forEach((replacement) => {
      const { piiType, startIndex, endIndex, placeholder, confidence, severity, value } = replacement;
      const before = sanitized.substring(0, startIndex);
      const after = sanitized.substring(endIndex);
      sanitized = before + placeholder + after;

      const key = `${piiType}_${startIndex}_${endIndex}`;
      mapping[key] = {
        piiType,
        placeholder,
        confidence: confidence || 0,
        severity,
        originalLength: value ? value.length : 0
      };
    });

  return { sanitized, mapping };
}

function mockGeneratePlaceholder(piiType, index) {
  if (["PASSWORD", "OTP", "CVV", "API_KEY", "AUTH_TOKEN", "SESSION_SECRET", "CARD", "CREDIT_CARD", "ACCESS_TOKEN", "JWT"].includes(piiType)) {
    return "<SECRET>";
  }
  return `<${piiType}_${index}>`;
}

function mockShouldSanitize(detection) {
  if (!detection || !detection.severity) {
    return false;
  }

  if (detection.severity === "CRITICAL" || detection.severity === "HIGH") {
    return true;
  }

  if (detection.severity === "CONTEXT_DEPENDENT") {
    return (detection.confidence || 0) >= 0.75;
  }

  return false;
}

// Main test runner
function runPrivacySanitizerTests() {
  console.clear();
  console.log("%c Privacy Sanitizer Test Suite", "color: #0066cc; font-size: 16px; font-weight: bold;");
  console.log("Testing DOM/text sanitization with placeholder replacement\n");

  const results = [];

  // Run all tests
  const basicTests = testBasicSanitization();
  results.push(...basicTests);

  const placeholderTests = testPlaceholderGeneration();
  results.push(...placeholderTests);

  const severityTests = testSeverityFiltering();
  results.push(...severityTests);

  const numberingTests = testConsistentNumbering();
  results.push(...numberingTests);

  // Summary
  console.log("\n%c Test Summary", "color: #0066cc; font-size: 14px; font-weight: bold;");
  const passedCount = results.filter((r) => r.passed).length;
  const totalCount = results.length;
  const passRate = ((passedCount / totalCount) * 100).toFixed(1);

  console.log(`✓ Passed: ${passedCount}/${totalCount} (${passRate}%)`);

  if (passedCount === totalCount) {
    console.log("%c All tests passed! ✓", "color: green; font-size: 12px; font-weight: bold;");
  } else {
    console.log("%c Some tests failed! ✗", "color: red; font-size: 12px; font-weight: bold;");
  }

  return {
    passed: passedCount,
    total: totalCount,
    passRate: parseFloat(passRate),
    results
  };
}

// Export for testing
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    runPrivacySanitizerTests,
    testBasicSanitization,
    testPlaceholderGeneration,
    testSeverityFiltering,
    testConsistentNumbering
  };
}

// Make globally available in browser
if (typeof window !== "undefined") {
  window.runPrivacySanitizerTests = runPrivacySanitizerTests;
}
