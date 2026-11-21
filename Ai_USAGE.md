# AI Usage Documentation

## 1. AI Tools Used

- **ChatGPT:** Used for understanding requirements, planning application architecture, debugging, code explanations, and improving implementation.
- **AI Coding Assistant:** Used for code suggestions, identifying errors, and improving development efficiency.

## 2. Areas Where AI Was Used

### A. Requirement Analysis and Project Planning
Used AI to understand the project requirements and break the application into modules.

**Prompt:**
"Analyze the requirements for a certificate management system with CSV candidate uploads, role-based authentication, multi-level approval workflows, certificate generation, QR verification, and WhatsApp notifications. Suggest a modular architecture and implementation plan."

### B. Database Design
Used AI to understand database relationships and identify the necessary tables.

**Prompt:**
"Suggest a PostgreSQL database schema for a certificate management system with users, roles, districts, training centres, candidate records, batches, approval decisions, certificates, and audit logs."

### C. Authentication and Authorization
Used AI to understand role-based access control and secure API implementation.

**Prompt:**
"Explain how to implement JWT authentication and role-based authorization for Centre Officers, District Officers, Quality Officers, and State Officers. Ensure users can access only the records permitted for their roles and districts."

### D. CSV Upload and Candidate Validation
Used AI to understand CSV parsing, data validation, duplicate detection, and error handling.

**Prompt:**
"Design a CSV upload workflow that validates enrollment numbers, candidate names, phone numbers, and dates of birth. Identify duplicate records and invalid entries, and provide meaningful validation errors."

### E. Multi-Level Approval Workflow
Used AI to understand approval rules and workflow transitions.

**Prompt:**
"Design a multi-level certificate approval workflow where two District Officers must approve a batch before it moves to the next stage. Route batches with 50 or fewer candidates to State Review and batches with more than 50 candidates to Quality Review."

### F. Certificate Generation
Used AI to understand automatic PDF generation and QR code integration.

**Prompt:**
"Explain how to generate individual PDF certificates using PDFKit, create unique certificate numbers, generate QR codes containing verification URLs, and securely store certificate download tokens."

### G. Background Jobs and Notifications
Used AI to understand background processing and notification workflows.

**Prompt:**
"Explain how to implement background jobs for certificate generation and WhatsApp notifications. Ensure PDF generation happens after final approval and candidates receive secure download links."

### H. Debugging and Testing
Used AI to investigate errors, understand unexpected application behaviour, and identify test scenarios.

**Prompt:**
"Review the approval workflow and identify possible issues such as duplicate approvals, unauthorized access, concurrent requests, missing validation, and failed background jobs. Suggest appropriate test cases."

## 3. How AI Suggestions Were Used

- Reviewed AI-generated suggestions before applying them.
- Adapted suggestions according to the actual project requirements.
- Verified API behaviour and database operations.
- Tested authentication, role permissions, CSV validation, and approval workflows.
- Reviewed certificate generation and download functionality.

## 4. Human Involvement

AI was used as a development assistance tool, not as a replacement for implementation and decision-making.

Project requirements, implementation decisions, code integration, debugging, and testing were reviewed and handled as part of the development process.

## 5. Conclusion

AI tools helped accelerate requirement analysis, technical understanding, debugging, and documentation. The final application was developed and tested against the specified functional requirements.