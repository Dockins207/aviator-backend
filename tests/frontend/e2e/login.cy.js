describe('Admin Login', () => {
  const validEmail = 'admin@aviator.com';
  const validPassword = 'secureAdminPassword123';

  beforeEach(() => {
    // Visit the login page before each test
    cy.visit('/login');
  });

  it('should successfully login with valid credentials', () => {
    // Input valid credentials
    cy.get('input[name="email"]').type(validEmail);
    cy.get('input[name="password"]').type(validPassword);
    
    // Click login button
    cy.get('button[type="submit"]').click();

    // Check for successful login redirection
    cy.url().should('include', '/dashboard');
    
    // Verify dashboard elements
    cy.get('[data-testid="dashboard-title"]').should('be.visible');
  });

  it('should show error with invalid credentials', () => {
    // Input invalid credentials
    cy.get('input[name="email"]').type('wrong@email.com');
    cy.get('input[name="password"]').type('wrongpassword');
    
    // Click login button
    cy.get('button[type="submit"]').click();

    // Check for error message
    cy.get('[data-testid="login-error"]').should('be.visible')
      .and('contain', 'Invalid credentials');
  });

  it('should prevent login with empty fields', () => {
    // Click login button without entering credentials
    cy.get('button[type="submit"]').click();

    // Check for validation errors
    cy.get('input[name="email"]:invalid').should('exist');
    cy.get('input[name="password"]:invalid').should('exist');
  });

  it('should have proper password input type', () => {
    // Check password input type
    cy.get('input[name="password"]')
      .should('have.attr', 'type', 'password');
  });
});
