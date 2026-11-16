/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return */
import { Test, TestingModule } from '@nestjs/testing';
import { StudentsService } from './students.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ClassGrade, Gender, UserRole } from '@prisma/client';
import { AuthTokenPayload } from '../../common/auth/token.service';

const mockPrismaService: any = {
  student: {
    create: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
  },
  school: {
    update: jest.fn(),
  },
  // Interactive transactions just run the callback against the same mock.
  $transaction: jest.fn((fn: (tx: any) => unknown) => fn(mockPrismaService)),
};

const mockAuditService = {
  log: jest.fn(),
};

describe('StudentsService', () => {
  let service: StudentsService;
  let prisma: any;

  const mockAdminUser: AuthTokenPayload = {
    sub: 'user-1',
    email: 'admin@school.com',
    role: UserRole.MAIN_ADMIN,
    schoolId: 'school-1',
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StudentsService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: AuditService, useValue: mockAuditService },
      ],
    }).compile();

    service = module.get<StudentsService>(StudentsService);
    prisma = module.get<PrismaService>(PrismaService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    it('should create a student successfully', async () => {
      const createDto = {
        firstName: 'John',
        lastName: 'Doe',
        dateOfBirth: '2010-01-01',
        gender: Gender.MALE,
        classGrade: ClassGrade.JSS_1,
        address: '123 Test St',
        guardianName: 'Jane Doe',
        guardianPhone: '08012345678',
      };

      prisma.student.count.mockResolvedValue(0);
      prisma.school.update.mockResolvedValue({ studentIdSeq: 42 });
      prisma.student.create.mockImplementation(({ data }: any) => ({
        id: 'stu-1',
        ...data,
      }));

      const result = await service.create(mockAdminUser, createDto);
      expect(result.studentId).toBe('AJO-000042');
      expect(prisma.school.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'school-1' },
          data: { studentIdSeq: { increment: 1 } },
        }),
      );
      expect(mockAuditService.log).toHaveBeenCalled();
    });
  });
});
