#!/bin/bash

# Aviator Deployment Script

# Exit on any error
set -e

# Environment variables
ENV=${1:-development}
REGISTRY="ghcr.io/yourusername/aviator"
TIMESTAMP=$(date +"%Y%m%d%H%M%S")

# Color codes
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

# Validate environment
validate_env() {
    if [[ "$ENV" != "development" && "$ENV" != "staging" && "$ENV" != "production" ]]; then
        echo -e "${RED}Invalid environment. Use 'development', 'staging', or 'production'.${NC}"
        exit 1
    fi
}

# Pre-deployment checks
pre_deploy_checks() {
    echo -e "${GREEN}Running pre-deployment checks...${NC}"
    
    # Check Docker
    if ! command -v docker &> /dev/null; then
        echo -e "${RED}Docker is not installed.${NC}"
        exit 1
    fi

    # Check Kubernetes context
    kubectl config current-context > /dev/null 2>&1 || {
        echo -e "${RED}No Kubernetes context selected.${NC}"
        exit 1
    }
}

# Build Docker images
build_images() {
    echo -e "${GREEN}Building Docker images...${NC}"
    
    docker build -t "${REGISTRY}/frontend:${TIMESTAMP}" ../frontend
    docker build -t "${REGISTRY}/backend:${TIMESTAMP}" ../backend
    docker build -t "${REGISTRY}/admin:${TIMESTAMP}" ../admin
}

# Push images to registry
push_images() {
    echo -e "${GREEN}Pushing images to registry...${NC}"
    
    docker push "${REGISTRY}/frontend:${TIMESTAMP}"
    docker push "${REGISTRY}/backend:${TIMESTAMP}"
    docker push "${REGISTRY}/admin:${TIMESTAMP}"
}

# Deploy to Kubernetes
deploy_to_k8s() {
    echo -e "${GREEN}Deploying to Kubernetes...${NC}"
    
    # Apply namespace and base configurations
    kubectl apply -f ../kubernetes/00-namespace.yml
    
    # Update image tags in deployments
    kubectl set image deployment/frontend frontend="${REGISTRY}/frontend:${TIMESTAMP}" -n aviator
    kubectl set image deployment/backend backend="${REGISTRY}/backend:${TIMESTAMP}" -n aviator
    kubectl set image deployment/admin admin="${REGISTRY}/admin:${TIMESTAMP}" -n aviator
    
    # Verify rollout
    kubectl rollout status deployment/frontend -n aviator
    kubectl rollout status deployment/backend -n aviator
    kubectl rollout status deployment/admin -n aviator
}

# Run database migrations
run_migrations() {
    echo -e "${GREEN}Running database migrations...${NC}"
    
    kubectl exec deployment/backend -n aviator -- npm run migrate
}

# Main deployment function
main() {
    validate_env
    pre_deploy_checks
    build_images
    push_images
    deploy_to_k8s
    run_migrations

    echo -e "${GREEN}Deployment to ${ENV} completed successfully!${NC}"
}

# Run the deployment
main

exit 0
