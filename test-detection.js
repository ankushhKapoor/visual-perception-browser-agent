const classifier = require('./extensions/src/privacy-classifier.js');

const testText = `Name: Rakshita Example
Phone: +91 90000 12345
Email: rakshita.demo@example.com
Address: 123 Example Street, Mumbai
Student ID: VIT-DEMO-2026
Password: DemoPassword123!
OTP: 482916
API Key: sk-demo-1234567890abcdef`;

console.log('=== Full-Page Text Detection Test ===');
const results = classifier.runAllDeterministicDetectors(testText);
console.log('Detected PII types:', [...new Set(results.map(r => r.piiType))]);
console.log('Total detections:', results.length);
results.forEach(r => console.log(`- ${r.piiType}: ${r.match || r.value}`));
